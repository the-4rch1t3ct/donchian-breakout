import type { Config } from '../config.js';
import type { StrategyLogger } from '../logger.js';
import type { IExchangeClient } from '../exchange/exchangeClient.js';
import type { DailyState, Side, TradeState } from '../types/index.js';

export class RiskService {
  private dailyState: DailyState;
  private config: Config;
  private logger: StrategyLogger;
  private exchange: IExchangeClient;

  constructor(config: Config, logger: StrategyLogger, exchange: IExchangeClient) {
    this.config = config;
    this.logger = logger;
    this.exchange = exchange;
    this.dailyState = {
      utcDayStart: this.getUtcDayStartMs(Date.now()),
      equityAtDayStart: 0,
      hardKillTriggered: false,
      softBrakeActive: false,
    };
  }

  getDailyState(): DailyState {
    return { ...this.dailyState };
  }

  getUtcDayStartMs(timestampMs: number): number {
    const d = new Date(timestampMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  async initDay(timestampMs: number, equity?: number): Promise<void> {
    const dayStart = this.getUtcDayStartMs(timestampMs);
    const eq = equity ?? await this.exchange.getEquity();
    this.dailyState = {
      utcDayStart: dayStart,
      equityAtDayStart: eq,
      hardKillTriggered: false,
      softBrakeActive: false,
    };
    this.logger.logSignal('', '', 'DAY_INIT', {
      riskSnapshot: {
        equity: eq,
        ddUtc: 0,
        riskPerTrade: this.config.riskPerTrade,
        sizeMult: 1,
        stopDist: 0,
        positionSize: 0,
        leverage: this.config.defaultLeverage,
      },
    });
  }

  checkDayBoundary(timestampMs: number): boolean {
    const currentDayStart = this.getUtcDayStartMs(timestampMs);
    return currentDayStart !== this.dailyState.utcDayStart;
  }

  computeDD(currentEquity: number): number {
    if (this.dailyState.equityAtDayStart <= 0) return 0;
    return (currentEquity - this.dailyState.equityAtDayStart) / this.dailyState.equityAtDayStart;
  }

  async updateDailyDD(timestampMs?: number): Promise<{ dd: number; softBrake: boolean; hardKill: boolean }> {
    const now = timestampMs ?? Date.now();

    if (this.checkDayBoundary(now)) {
      await this.initDay(now);
    }

    const equity = await this.exchange.getEquity();
    const dd = this.computeDD(equity);

    const hardKill = dd <= this.config.hardDdThreshold;
    const softBrake = dd <= this.config.softDdThreshold;

    if (hardKill && !this.dailyState.hardKillTriggered) {
      this.dailyState.hardKillTriggered = true;
      this.logger.logSignal('', '', 'HARD_KILL_SWITCH_TRIGGERED', {
        riskSnapshot: {
          equity,
          ddUtc: dd,
          riskPerTrade: 0,
          sizeMult: 0,
          stopDist: 0,
          positionSize: 0,
          leverage: 0,
        },
      });
    }

    this.dailyState.softBrakeActive = softBrake && !hardKill;
    if (this.dailyState.softBrakeActive) {
      this.logger.logSignal('', '', 'SOFT_BRAKE_ACTIVE', {
        riskSnapshot: {
          equity,
          ddUtc: dd,
          riskPerTrade: this.config.riskPerTrade,
          sizeMult: this.config.softBrakeSizeMult,
          stopDist: 0,
          positionSize: 0,
          leverage: this.config.defaultLeverage,
        },
      });
    }

    return { dd, softBrake: this.dailyState.softBrakeActive, hardKill: this.dailyState.hardKillTriggered };
  }

  async executeHardKill(openTrades: TradeState[]): Promise<void> {
    this.logger.logSignal('', '', 'HARD_KILL_EXECUTING', {
      details: { positionCount: openTrades.length },
    });

    await this.exchange.cancelAll();

    for (const trade of openTrades) {
      try {
        await this.exchange.closePosition(trade.symbol, trade.side, trade.size);
        this.logger.logSignal(trade.symbol, trade.side, 'POSITION_CLOSED_KILL_SWITCH', {
          exitReason: 'DAILY_KILL_SWITCH',
        });
      } catch (err) {
        this.logger.logSignal(trade.symbol, trade.side, 'ERROR_CLOSING_POSITION', {
          exitReason: 'EXCHANGE_ERROR',
          details: { error: String(err) },
        });
      }
    }
  }

  isKilled(): boolean {
    return this.dailyState.hardKillTriggered;
  }

  isSoftBrake(): boolean {
    return this.dailyState.softBrakeActive;
  }

  getSizeMult(): number {
    if (this.dailyState.hardKillTriggered) return 0;
    if (this.dailyState.softBrakeActive) return this.config.softBrakeSizeMult;
    return 1;
  }

  computePositionSize(
    equity: number,
    stopDistPct: number,
    sizeMult: number,
  ): { size: number; leverage: number } {
    const riskAmount = equity * this.config.riskPerTrade * sizeMult;
    if (stopDistPct <= 0) return { size: 0, leverage: this.config.defaultLeverage };

    const notional = riskAmount / stopDistPct;
    let leverage: number = this.config.defaultLeverage;

    // TODO: compute precise liquidation distance from Hyperliquid margin rules
    const liqDistEst = 1 / leverage - this.config.maintenanceMarginRate;
    const stopDist = stopDistPct;

    if (liqDistEst >= this.config.liquidationBufferMult * stopDist && leverage < this.config.maxLeverage) {
      leverage = Math.min(this.config.maxLeverage, leverage);
    }

    const maxSize = (equity * leverage);
    const size = Math.min(notional, maxSize);

    return { size: size > 0 ? size : 0, leverage };
  }

  computeOpenRisk(openTrades: TradeState[]): number {
    let total = 0;
    for (const t of openTrades) {
      total += t.riskAmount;
    }
    return total;
  }

  canOpenNew(openTrades: TradeState[], equity: number, newRiskAmount: number, symbol: string, clusterFn: (s: string) => string): {
    allowed: boolean;
    reason?: string;
  } {
    if (this.dailyState.hardKillTriggered) {
      return { allowed: false, reason: 'HARD_KILL_ACTIVE' };
    }

    if (openTrades.length >= this.config.maxConcurrentPositions) {
      return { allowed: false, reason: 'MAX_CONCURRENT_POSITIONS' };
    }

    const openRisk = this.computeOpenRisk(openTrades);
    if ((openRisk + newRiskAmount) / equity > this.config.maxOpenRisk) {
      return { allowed: false, reason: 'MAX_OPEN_RISK_EXCEEDED' };
    }

    const cluster = clusterFn(symbol);
    const clusterCount = openTrades.filter(t => clusterFn(t.symbol) === cluster).length;
    if (clusterCount >= this.config.maxPositionsPerCluster) {
      return { allowed: false, reason: 'MAX_CLUSTER_POSITIONS' };
    }

    return { allowed: true };
  }

  /** Force daily state for testing / sim. */
  setDailyState(state: Partial<DailyState>): void {
    Object.assign(this.dailyState, state);
  }
}
