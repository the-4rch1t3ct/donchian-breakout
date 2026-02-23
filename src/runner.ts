import type { Config } from './config.js';
import type { StrategyLogger } from './logger.js';
import type { IExchangeClient } from './exchange/exchangeClient.js';
import type { RiskService } from './services/riskService.js';
import type { ExecutionService } from './services/executionService.js';
import type { UniverseService } from './services/universeService.js';
import { DonchianBreakout15m } from './strategy/donchianBreakout15m.js';
import type { TradingMode } from './types/index.js';

export interface RunnerDeps {
  config: Config;
  logger: StrategyLogger;
  exchange: IExchangeClient;
  riskService: RiskService;
  executionService: ExecutionService;
  universeService: UniverseService;
  protectionService: import('./services/protectionService.js').ProtectionService;
  mode: TradingMode;
}

/**
 * Runs the strategy in real-time (paper or live mode).
 * Waits for 15m candle boundaries, fetches data, calls strategy.onBar per symbol.
 */
export class Runner {
  private strategy: DonchianBreakout15m;
  private exchange: IExchangeClient;
  private riskService: RiskService;
  private universeService: UniverseService;
  private logger: StrategyLogger;
  private config: Config;
  private protectionService: import('./services/protectionService.js').ProtectionService;
  private mode: TradingMode;
  private running = false;
  private shutdownResolve: (() => void) | null = null;

  constructor(deps: RunnerDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.exchange = deps.exchange;
    this.riskService = deps.riskService;
    this.universeService = deps.universeService;
    this.protectionService = deps.protectionService;
    this.mode = deps.mode;

    this.strategy = new DonchianBreakout15m(
      deps.config,
      deps.logger,
      deps.exchange,
      deps.riskService,
      deps.executionService,
      deps.universeService,
      deps.protectionService,
    );
  }

  getStrategy(): DonchianBreakout15m {
    return this.strategy;
  }

  async start(): Promise<void> {
    if (this.mode === 'live') {
      this.enforceLiveSafetyGate();
    }

    await this.startupChecks();

    this.running = true;
    this.logger.logEvent('RUNNER', 'RUNNER_STARTED', '', '', {
      details: { mode: this.mode, symbols: this.universeService.getSymbols() },
    });

    while (this.running) {
      await this.waitForNextCandleClose();
      if (!this.running) break;

      try {
        await this.tick();
      } catch (err) {
        this.logger.logEvent('RUNNER', 'TICK_ERROR', '', '', {
          details: { error: String(err) },
        });
      }
    }

    this.logger.logEvent('RUNNER', 'RUNNER_STOPPED', '', '', {});
    this.shutdownResolve?.();
  }

  stop(): Promise<void> {
    this.running = false;
    return new Promise(resolve => {
      this.shutdownResolve = resolve;
    });
  }

  private enforceLiveSafetyGate(): void {
    if (process.env.LIVE_TRADING !== 'true') {
      this.logger.logEvent('RUNNER', 'LIVE_BLOCKED_NO_ENV', '', '', {
        details: { msg: 'Set LIVE_TRADING=true to enable live trading' },
      });
      throw new Error('Live trading requires LIVE_TRADING=true environment variable');
    }
  }

  async startupChecks(): Promise<void> {
    // Universe refresh/build (auto universe builder runs here if enabled)
    if (this.universeService.needsRefresh()) {
      await this.universeService.refresh(this.exchange);
    }

    const requestedSymbols = this.universeService.getSymbols();
    const equity = await this.exchange.getEquity();
    const positions = await this.exchange.getPositions();
    const connectivity: Record<string, string> = {};
    const symbols: string[] = [];

    for (const symbol of requestedSymbols) {
      try {
        const book = await this.exchange.getOrderBookTop(symbol);
        connectivity[symbol] = `spreadBps=${book.spreadBps.toFixed(1)}`;
        symbols.push(symbol);
      } catch (err) {
        this.logger.logEvent('RUNNER', 'STARTUP_SKIP_SYMBOL', symbol, '', {
          details: { reason: 'not_available_or_error', error: String(err) },
        });
      }
    }

    if (symbols.length < this.config.minSymbols) {
      throw new Error(
        `Only ${symbols.length} symbols available (min ${this.config.minSymbols}). Skipped: ${requestedSymbols.filter(s => !symbols.includes(s)).join(', ')}`,
      );
    }

    this.universeService.setSymbols(symbols);

    await this.riskService.initDay(Date.now(), equity);

    // Immediately sync protection meta so ops-watchdog doesn't flag desync after restarts.
    try {
      await this.protectionService.scanAndRepair();
    } catch (err) {
      this.logger.logEvent('RUNNER', 'PROTECTION_SCAN_ERROR', '', '', {
        details: { error: String(err) },
      });
    }

    this.logger.logEvent('RUNNER', 'LIVE_STARTUP_CHECK', '', '', {
      details: {
        mode: this.mode,
        symbols,
        skipped: requestedSymbols.filter(s => !symbols.includes(s)),
        equity,
        positionCount: positions.length,
        positions: positions.map(p => ({ sym: p.symbol, side: p.side, size: p.size })),
        connectivity,
        maxNotional: this.config.maxNotionalPerSymbol,
        riskPerTrade: this.config.riskPerTrade,
        maxConcurrent: this.config.maxConcurrentPositions,
        hardDdThreshold: this.config.hardDdThreshold,
        softDdThreshold: this.config.softDdThreshold,
        hlBaseUrl: this.config.hlBaseUrl,
        hlWallet: this.config.hlWalletAddress
          ? `${this.config.hlWalletAddress.slice(0, 6)}...${this.config.hlWalletAddress.slice(-4)}`
          : 'not set',
      },
    });
  }

  async tick(): Promise<void> {
    const now = Date.now();

    // Periodic universe refresh/build (by default every UNIVERSE_REFRESH_HOURS).
    if (this.universeService.needsRefresh()) {
      try {
        await this.universeService.refresh(this.exchange);
      } catch (err) {
        this.logger.logEvent('RUNNER', 'UNIVERSE_REFRESH_ERROR', '', '', {
          details: { error: String(err) },
        });
      }
    }

    const equity = await this.exchange.getEquity();
    const { dd, softBrake, hardKill } = await this.riskService.updateDailyDD(now, equity);
    if (hardKill) {
      await this.executeKillSwitch();
      return;
    }

    const tickContext = { equity, dd, softBrake };
    const symbols = this.universeService.getSymbols();
    const candleCount = this.config.candleHistoryBars;

    for (const symbol of symbols) {
      try {
        const candles = await this.exchange.getCandles(
          symbol,
          this.config.signalTimeframeMs,
          candleCount,
        );

        if (candles.length < 30) {
          this.logger.logEvent('RUNNER', 'INSUFFICIENT_CANDLES', symbol, '', {
            details: { count: candles.length, required: 30 },
          });
          continue;
        }

        await this.strategy.onBar(symbol, candles, now, tickContext);
      } catch (err) {
        this.logger.logEvent('RUNNER', 'SYMBOL_TICK_ERROR', symbol, '', {
          details: { error: String(err) },
        });
      }
    }

    // Repair any naked positions (missing SL/TP) every tick.
    try {
      await this.protectionService.scanAndRepair();
    } catch (err) {
      this.logger.logEvent('RUNNER', 'PROTECTION_SCAN_ERROR', '', '', {
        details: { error: String(err) },
      });
    }
  }

  private async executeKillSwitch(): Promise<void> {
    this.logger.logEvent('RISK', 'KILL_SWITCH_TRIGGERED', '', '', {
      details: { action: 'cancelling_all_then_flatten' },
    });

    try {
      await this.exchange.cancelAll();
      this.logger.logEvent('RISK', 'ORDER_CANCELLED', '', '', {
        details: { action: 'cancel_all_for_kill_switch' },
      });
    } catch (err) {
      this.logger.logEvent('RISK', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'cancelAll_killSwitch', error: String(err) },
      });
    }

    const openTrades = this.strategy.getOpenTrades();
    this.logger.logEvent('RISK', 'FLATTEN_ALL', '', '', {
      details: { positionCount: openTrades.length },
    });

    for (const trade of openTrades) {
      try {
        await this.exchange.closePosition(trade.symbol, trade.side, trade.size);
        this.logger.logEvent('RISK', 'ORDER_FILLED', trade.symbol, trade.side, {
          exitReason: 'DAILY_KILL_SWITCH',
          details: { action: 'kill_switch_flatten' },
        });
      } catch (err) {
        this.logger.logEvent('RISK', 'EXCHANGE_API_ERROR', trade.symbol, trade.side, {
          details: { method: 'closePosition_killSwitch', error: String(err) },
        });
      }
    }
  }

  private async waitForNextCandleClose(): Promise<void> {
    const interval = this.config.signalTimeframeMs;
    const now = Date.now();
    const nextBoundary = Math.ceil(now / interval) * interval;
    const waitMs = nextBoundary - now + 5_000; // 5s buffer after candle close

    this.logger.logEvent('RUNNER', 'WAITING_FOR_CANDLE', '', '', {
      details: {
        nextBoundary: new Date(nextBoundary).toISOString(),
        waitMs,
      },
    });

    await this.sleep(waitMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (!this.running) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }
}

/** Creates the correct exchange client. Must use await for dynamic imports. */
export async function createExchangeClient(
  mode: TradingMode,
  config: Config,
  logger: StrategyLogger,
): Promise<IExchangeClient> {
  if (mode === 'sim') {
    const { SimExchangeClient } = await import('./exchange/simExchangeClient.js');
    return new SimExchangeClient(10_000);
  }

  if (mode === 'paper') {
    const { PaperExchangeClient } = await import('./exchange/paperExchangeClient.js');
    return new PaperExchangeClient({
      statePath: config.paperStatePath,
      initialEquity: config.paperInitialEquity,
      baseUrl: config.hlBaseUrl,
      logger,
      takerFeeBps: config.takerFeeBps,
      makerFeeBps: config.makerFeeBps,
    });
  }

  if (mode === 'live') {
    if (!config.hlWalletAddress || !config.hlPrivateKey) {
      throw new Error('Live mode requires HL_WALLET_ADDRESS and HL_PRIVATE_KEY env vars');
    }
    const { HyperliquidExchangeClient } = await import('./exchange/hyperliquidExchangeClient.js');
    const client = new HyperliquidExchangeClient({
      walletAddress: config.hlWalletAddress,
      privateKey: config.hlPrivateKey,
      baseUrl: config.hlBaseUrl,
      logger,
      minNotionalPerOrder: config.minNotionalPerOrder,
      maxNotionalPerSymbol: config.maxNotionalPerSymbol,
      takerFeeBps: config.takerFeeBps,
      makerFeeBps: config.makerFeeBps,
    });
    await client.init();
    return client;
  }

  throw new Error(`Unknown mode: ${mode}`);
}
