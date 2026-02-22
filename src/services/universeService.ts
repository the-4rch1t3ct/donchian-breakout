import type { Config } from '../config.js';
import type { StrategyLogger } from '../logger.js';

export interface UniverseStats {
  symbol: string;
  avgSpreadBps: number;
  wickStopCount: number;
  score: number;
}

/**
 * Maintains a list of tradable Tier-A symbols.
 * For now: uses a manually-provided default list.
 * TODO: Implement full ranking based on spread, volume, wick-stop stats from own fills.
 */
export class UniverseService {
  private symbols: string[];
  private lastRefresh: number = 0;
  private stats: Map<string, UniverseStats> = new Map();
  private refreshIntervalMs: number;

  constructor(
    private config: Config,
    private logger: StrategyLogger,
  ) {
    this.symbols = [...config.defaultSymbols];
    this.refreshIntervalMs = config.universeRefreshHours * 3600 * 1000;
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  setSymbols(symbols: string[]): void {
    this.symbols = symbols.slice(0, this.config.maxSymbols);
    this.logger.logSignal('', '', 'UNIVERSE_UPDATED', {
      details: { symbols: this.symbols, count: this.symbols.length },
    });
  }

  needsRefresh(): boolean {
    return Date.now() - this.lastRefresh > this.refreshIntervalMs;
  }

  /**
   * Refresh universe ranking.
   * TODO: Implement real scoring based on:
   *  - Average spread from recent order book snapshots
   *  - Slippage from own fills
   *  - Wick-stop frequency (positions stopped by wicks that immediately reversed)
   *  - Volume rank
   */
  async refresh(): Promise<void> {
    this.lastRefresh = Date.now();
    this.logger.logSignal('', '', 'UNIVERSE_REFRESH', {
      details: { symbols: this.symbols },
    });
  }

  recordFillStats(symbol: string, spreadBps: number, wasWickStop: boolean): void {
    const existing = this.stats.get(symbol) ?? {
      symbol,
      avgSpreadBps: 0,
      wickStopCount: 0,
      score: 0,
    };
    existing.avgSpreadBps = existing.avgSpreadBps * 0.95 + spreadBps * 0.05;
    if (wasWickStop) existing.wickStopCount++;
    this.stats.set(symbol, existing);
  }

  /** Hook for cluster/sector grouping. TODO: real implementation. */
  getCluster(_symbol: string): string {
    return 'default';
  }
}
