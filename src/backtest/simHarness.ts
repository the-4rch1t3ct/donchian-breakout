import { CONFIG, type Config } from '../config.js';
import { StrategyLogger } from '../logger.js';
import { SimExchangeClient } from '../exchange/simExchangeClient.js';
import { RiskService } from '../services/riskService.js';
import { ExecutionService } from '../services/executionService.js';
import { UniverseService } from '../services/universeService.js';
import { DonchianBreakout15m } from '../strategy/donchianBreakout15m.js';
import type { Candle } from '../types/index.js';

export interface SimResult {
  totalBars: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalR: number;
  avgR: number;
  maxDD: number;
  finalEquity: number;
  equityCurve: number[];
  trades: Array<{
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    realizedR: number;
    exitReason: string;
    bars: number;
  }>;
}

/**
 * Backtest/simulation harness.
 * Takes a map of symbol→15m candles, runs the strategy bar-by-bar.
 */
export class SimHarness {
  private config: Config;
  private initialEquity: number;

  constructor(config?: Partial<Config>, initialEquity = 10_000) {
    this.config = { ...CONFIG, ...config } as Config;
    this.initialEquity = initialEquity;
  }

  async run(candlesBySymbol: Map<string, Candle[]>): Promise<SimResult> {
    const logger = new StrategyLogger(null);
    const exchange = new SimExchangeClient(this.initialEquity);
    const riskService = new RiskService(this.config, logger, exchange);
    const executionService = new ExecutionService(this.config, logger, exchange);
    const universeService = new UniverseService(this.config, logger);

    const strategy = new DonchianBreakout15m(
      this.config,
      logger,
      exchange,
      riskService,
      executionService,
      universeService,
    );

    const symbols = Array.from(candlesBySymbol.keys());
    universeService.setSymbols(symbols);

    const allTimestamps = new Set<number>();
    for (const [, candles] of candlesBySymbol) {
      for (const c of candles) allTimestamps.add(c.timestamp);
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    const equityCurve: number[] = [];
    let maxEquity = this.initialEquity;
    let maxDD = 0;
    let lastDayInit = 0;

    const minCandles = Math.max(
      this.config.donchianLength + 1,
      this.config.atrLength + 1,
      2 * this.config.adxLength + 1,
    );

    for (const ts of sortedTimestamps) {
      const dayStart = riskService.getUtcDayStartMs(ts);
      if (dayStart !== lastDayInit) {
        const eq = await exchange.getEquity();
        await riskService.initDay(ts, eq);
        lastDayInit = dayStart;
      }

      for (const symbol of symbols) {
        const allCandles = candlesBySymbol.get(symbol)!;
        const idx = allCandles.findIndex(c => c.timestamp === ts);
        if (idx < 0) continue;

        exchange.setCurrentCandle(symbol, allCandles[idx]);
        const historySlice = allCandles.slice(0, idx + 1);
        if (historySlice.length < minCandles) continue;

        await strategy.onBar(symbol, historySlice, ts);
      }

      const equity = await exchange.getEquity();
      equityCurve.push(equity);
      if (equity > maxEquity) maxEquity = equity;
      const dd = (equity - maxEquity) / maxEquity;
      if (dd < maxDD) maxDD = dd;
    }

    if (strategy.getOpenTrades().length > 0) {
      await strategy.forceCloseAll('MANUAL', sortedTimestamps[sortedTimestamps.length - 1]);
    }

    const logEntries = logger.getBuffer();
    const trades: SimResult['trades'] = [];
    let winCount = 0;
    let lossCount = 0;
    let totalR = 0;

    for (const entry of logEntries) {
      if (entry.event === 'POSITION_CLOSED' && entry.realizedR !== undefined) {
        trades.push({
          symbol: entry.symbol,
          side: entry.side,
          entryPrice: (entry.details?.entryPrice as number) ?? 0,
          exitPrice: (entry.details?.exitPrice as number) ?? 0,
          realizedR: entry.realizedR,
          exitReason: entry.exitReason ?? 'MANUAL',
          bars: (entry.details?.holdBars as number) ?? 0,
        });
        totalR += entry.realizedR;
        if (entry.realizedR > 0) winCount++;
        else lossCount++;
      }
    }

    const totalTrades = trades.length;
    const finalEquity = await exchange.getEquity();

    logger.close();

    return {
      totalBars: sortedTimestamps.length,
      totalTrades,
      winCount,
      lossCount,
      winRate: totalTrades > 0 ? winCount / totalTrades : 0,
      totalR,
      avgR: totalTrades > 0 ? totalR / totalTrades : 0,
      maxDD,
      finalEquity,
      equityCurve,
      trades,
    };
  }
}
