import type { Config } from '../config.js';
import type { StrategyLogger } from '../logger.js';
import type { IExchangeClient } from '../exchange/exchangeClient.js';
import type { RiskService } from '../services/riskService.js';
import type { ExecutionService } from '../services/executionService.js';
import type { UniverseService } from '../services/universeService.js';
import { donchian, donchianWidthPct } from '../indicators/donchian.js';
import { atr } from '../indicators/atr.js';
import { adx } from '../indicators/adx.js';
import type {
  Candle,
  CooldownEntry,
  ExitReason,
  IndicatorSnapshot,
  Side,
  TradeState,
} from '../types/index.js';

export class DonchianBreakout15m {
  private openTrades: Map<string, TradeState> = new Map();
  private cooldowns: CooldownEntry[] = [];
  private barIndex = 0;

  constructor(
    private config: Config,
    private logger: StrategyLogger,
    private exchange: IExchangeClient,
    private riskService: RiskService,
    private executionService: ExecutionService,
    private universeService: UniverseService,
  ) {}

  getOpenTrades(): TradeState[] {
    return Array.from(this.openTrades.values());
  }

  getOpenTradeForSymbol(symbol: string): TradeState | undefined {
    return this.openTrades.get(symbol);
  }

  getBarIndex(): number {
    return this.barIndex;
  }

  /**
   * Per-tick context from runner (equity fetched once per 15m bar).
   * When provided, strategy uses cached equity/dd/softBrake and does not call exchange.getEquity() or riskService.updateDailyDD().
   */
  async onBar(
    symbol: string,
    candles15m: Candle[],
    timestampMs: number,
    tickContext?: { equity: number; dd: number; softBrake: boolean },
  ): Promise<void> {
    this.barIndex++;

    let dd: number;
    let softBrake: boolean;

    if (tickContext) {
      dd = tickContext.dd;
      softBrake = tickContext.softBrake;
    } else {
      const result = await this.riskService.updateDailyDD(timestampMs);
      dd = result.dd;
      softBrake = result.softBrake;
      if (result.hardKill) {
        await this.riskService.executeHardKill(this.getOpenTrades());
        this.openTrades.clear();
        return;
      }
    }

    const existingTrade = this.openTrades.get(symbol);
    if (existingTrade) {
      await this.manageExistingPosition(symbol, existingTrade, candles15m, timestampMs);
      return;
    }

    if (this.riskService.isKilled()) return;

    const minCandles = Math.max(
      this.config.donchianLength + 1,
      this.config.atrLength + 1,
      2 * this.config.adxLength + 1,
    );
    if (candles15m.length < minCandles) return;

    const indicators = this.computeIndicators(candles15m);
    if (!indicators) return;

    const currentCandle = candles15m[candles15m.length - 1];
    const signal = this.checkEntrySignal(symbol, currentCandle, candles15m, indicators, softBrake);
    if (!signal) return;

    if (this.isOnCooldown(symbol, signal.side)) {
      this.logger.logSignal(symbol, signal.side, 'SKIPPED_COOLDOWN', {
        executionPath: 'SKIPPED_FILTERS',
        details: { barIndex: this.barIndex },
      });
      return;
    }

    const equity = tickContext?.equity ?? (await this.exchange.getEquity());
    const sizeMult = this.riskService.getSizeMult();
    const stopDist = this.config.stopAtrMult * indicators.atr;
    const stopDistPct = stopDist / currentCandle.close;

    const { size, leverage } = this.riskService.computePositionSize(equity, stopDistPct, sizeMult);
    if (size <= 0) return;

    const positionSizeInUnits = size / currentCandle.close;
    const orderNotional = positionSizeInUnits * currentCandle.close;

    if (orderNotional < this.config.minNotionalPerOrder) {
      this.logger.logSignal(symbol, signal.side, 'SKIPPED_TOO_SMALL', {
        executionPath: 'SKIPPED_FILTERS',
        details: { notional: orderNotional, minNotional: this.config.minNotionalPerOrder, sizeUnits: positionSizeInUnits },
        riskSnapshot: {
          equity, ddUtc: dd, riskPerTrade: this.config.riskPerTrade,
          sizeMult, stopDist: stopDistPct, positionSize: positionSizeInUnits, leverage,
        },
      });
      return;
    }

    const riskAmount = equity * this.config.riskPerTrade * sizeMult;

    const canOpen = this.riskService.canOpenNew(
      this.getOpenTrades(),
      equity,
      riskAmount,
      symbol,
      (s) => this.universeService.getCluster(s),
    );

    if (!canOpen.allowed) {
      this.logger.logSignal(symbol, signal.side, `SKIPPED_RISK: ${canOpen.reason}`, {
        executionPath: 'SKIPPED_FILTERS',
        riskSnapshot: {
          equity,
          ddUtc: dd,
          riskPerTrade: this.config.riskPerTrade,
          sizeMult,
          stopDist: stopDistPct,
          positionSize: positionSizeInUnits,
          leverage,
        },
      });
      return;
    }

    this.logger.logSignal(symbol, signal.side, 'ENTRY_SIGNAL', {
      signalParams: this.signalParams(currentCandle, indicators),
      riskSnapshot: {
        equity,
        ddUtc: dd,
        riskPerTrade: this.config.riskPerTrade,
        sizeMult,
        stopDist: stopDistPct,
        positionSize: positionSizeInUnits,
        leverage,
      },
    });

    const { path, fill } = this.config.mode === 'sim'
      ? await this.executionService.executeEntrySim(symbol, signal.side, positionSizeInUnits, currentCandle.close)
      : await this.executionService.executeEntry(symbol, signal.side, positionSizeInUnits, currentCandle.close);

    if (!fill.filled || !fill.fillPrice) {
      this.logger.logSignal(symbol, signal.side, 'ENTRY_NOT_FILLED', {
        executionPath: path,
      });
      return;
    }

    const initialStop = signal.side === 'long'
      ? fill.fillPrice - stopDist
      : fill.fillPrice + stopDist;

    const trailDist = this.config.trailAtrMult * indicators.atr;
    const trailingStop = signal.side === 'long'
      ? currentCandle.close - trailDist
      : currentCandle.close + trailDist;

    const trade: TradeState = {
      symbol,
      side: signal.side,
      entryPrice: fill.fillPrice,
      entryTime: timestampMs,
      size: fill.fillSize ?? positionSizeInUnits,
      leverage,
      initialStop,
      trailingStop: signal.side === 'long'
        ? Math.max(initialStop, trailingStop)
        : Math.min(initialStop, trailingStop),
      atrAtEntry: indicators.atr,
      riskAmount,
      executionPath: path,
    };

    this.openTrades.set(symbol, trade);

    this.logger.logSignal(symbol, signal.side, 'POSITION_OPENED', {
      executionPath: path,
      slippageBps: fill.slippageBps,
      fees: fill.fees,
      riskSnapshot: {
        equity,
        ddUtc: dd,
        riskPerTrade: this.config.riskPerTrade,
        sizeMult,
        stopDist: stopDistPct,
        positionSize: trade.size,
        leverage,
      },
    });
  }

  private async manageExistingPosition(
    symbol: string,
    trade: TradeState,
    candles15m: Candle[],
    timestampMs: number,
  ): Promise<void> {
    const currentCandle = candles15m[candles15m.length - 1];
    const currentAtr = this.computeCurrentAtr(candles15m);

    const exitCheck = this.checkStopHit(trade, currentCandle);
    if (exitCheck.hit) {
      await this.closeTradeWithReason(trade, exitCheck.reason, exitCheck.exitPrice, timestampMs);
      return;
    }

    this.updateTrailingStop(trade, currentCandle, currentAtr);
  }

  private checkStopHit(trade: TradeState, candle: Candle): {
    hit: boolean;
    reason: ExitReason;
    exitPrice: number;
  } {
    if (trade.side === 'long') {
      const activeStop = Math.max(trade.initialStop, trade.trailingStop);
      if (candle.low <= activeStop) {
        return {
          hit: true,
          reason: trade.trailingStop > trade.initialStop ? 'TRAIL' : 'STOP_INITIAL',
          exitPrice: activeStop,
        };
      }
    } else {
      const activeStop = Math.min(trade.initialStop, trade.trailingStop);
      if (candle.high >= activeStop) {
        return {
          hit: true,
          reason: trade.trailingStop < trade.initialStop ? 'TRAIL' : 'STOP_INITIAL',
          exitPrice: activeStop,
        };
      }
    }
    return { hit: false, reason: 'STOP_INITIAL', exitPrice: 0 };
  }

  updateTrailingStop(trade: TradeState, candle: Candle, currentAtr: number): void {
    const trailDist = this.config.trailAtrMult * currentAtr;

    if (trade.side === 'long') {
      const candidate = candle.close - trailDist;
      trade.trailingStop = Math.max(trade.trailingStop, candidate);
    } else {
      const candidate = candle.close + trailDist;
      trade.trailingStop = Math.min(trade.trailingStop, candidate);
    }
  }

  private async closeTradeWithReason(
    trade: TradeState,
    reason: ExitReason,
    exitPrice: number,
    timestampMs: number,
  ): Promise<void> {
    const pnlMult = trade.side === 'long' ? 1 : -1;
    const pnlPerUnit = (exitPrice - trade.entryPrice) * pnlMult;
    const riskPerUnit = trade.riskAmount / trade.size;
    const realizedR = riskPerUnit > 0 ? pnlPerUnit / (riskPerUnit) : 0;

    const fill = await this.exchange.closePosition(trade.symbol, trade.side, trade.size);

    this.logger.logSignal(trade.symbol, trade.side, 'POSITION_CLOSED', {
      exitReason: reason,
      realizedR,
      fees: fill.fees,
      slippageBps: fill.slippageBps,
      details: {
        entryPrice: trade.entryPrice,
        exitPrice: fill.fillPrice ?? exitPrice,
        holdBars: this.barIndex,
        pnlPerUnit,
      },
    });

    this.openTrades.delete(trade.symbol);
    this.addCooldown(trade.symbol, trade.side, this.barIndex);
  }

  private computeIndicators(candles15m: Candle[]): IndicatorSnapshot | null {
    try {
      const lookback = candles15m.slice(0, -1);
      const dc = donchian(lookback, this.config.donchianLength);
      const widthPct = donchianWidthPct(dc);
      const atrVal = atr(candles15m, this.config.atrLength);
      const adxVal = adx(candles15m, this.config.adxLength);
      const price = candles15m[candles15m.length - 1].close;

      return {
        donchianHigh: dc.high,
        donchianLow: dc.low,
        atr: atrVal,
        atrPct: atrVal / price,
        adx: adxVal,
        widthPct,
      };
    } catch {
      return null;
    }
  }

  private signalParams(candle: Candle, indicators: IndicatorSnapshot): {
    N: number;
    bufferBps: number;
    atrPct: number;
    adx: number;
    candleRangeAtr: number;
    widthPct: number;
  } {
    return {
      N: this.config.donchianLength,
      bufferBps: this.config.bufferBps,
      atrPct: indicators.atrPct,
      adx: indicators.adx,
      candleRangeAtr: (candle.high - candle.low) / indicators.atr,
      widthPct: indicators.widthPct,
    };
  }

  private computeCurrentAtr(candles15m: Candle[]): number {
    try {
      return atr(candles15m, this.config.atrLength);
    } catch {
      return 0;
    }
  }

  private checkEntrySignal(
    symbol: string,
    candle: Candle,
    candles15m: Candle[],
    indicators: IndicatorSnapshot,
    softBrake: boolean,
  ): { side: Side } | null {
    const bufferMult = this.config.bufferBps / 10_000;

    const longBreak = candle.close >= indicators.donchianHigh * (1 + bufferMult);
    const shortBreak = candle.close <= indicators.donchianLow * (1 - bufferMult);

    if (!longBreak && !shortBreak) {
      this.logger.logSignal(symbol, '', 'NO_SIGNAL', {
        executionPath: 'NO_SIGNAL',
        details: { reason: 'no_breakout' },
        signalParams: this.signalParams(candle, indicators),
      });
      return null;
    }

    const side: Side = longBreak ? 'long' : 'short';

    if (this.config.enableWidthFilter) {
      const threshold = softBrake ? this.config.widthPctMinSoft : this.config.widthPctMin;
      if (indicators.widthPct < threshold) {
        this.logger.logSignal(symbol, side, 'SKIPPED_LOW_WIDTH_PCT', {
          executionPath: 'SKIPPED_FILTERS',
          details: {
            widthPct: indicators.widthPct,
            threshold,
            softBrake,
          },
          signalParams: this.signalParams(candle, indicators),
        });
        return null;
      }
    }

    const minAtrPct = softBrake ? this.config.softBrakeMinAtrPct : this.config.minAtrPct;
    const minAdx = softBrake ? this.config.softBrakeMinAdx : this.config.minAdx;
    const maxRangeAtr = softBrake ? this.config.softBrakeMaxCandleRangeAtr : this.config.maxCandleRangeAtr;

    if (indicators.atrPct < minAtrPct) {
      this.logger.logSignal(symbol, side, 'SKIPPED_LOW_ATR_PCT', {
        executionPath: 'SKIPPED_FILTERS',
        signalParams: this.signalParams(candle, indicators),
      });
      return null;
    }

    const maxAtrPct = softBrake ? this.config.atrPctMaxSoft : this.config.atrPctMax;
    if (Number.isFinite(maxAtrPct) && indicators.atrPct > maxAtrPct) {
      this.logger.logSignal(symbol, side, 'SKIPPED_HIGH_ATR_PCT', {
        executionPath: 'SKIPPED_FILTERS',
        details: {
          atrPct: indicators.atrPct,
          threshold: maxAtrPct,
          softBrake,
        },
        signalParams: this.signalParams(candle, indicators),
      });
      return null;
    }

    if (indicators.adx < minAdx) {
      this.logger.logSignal(symbol, side, 'SKIPPED_LOW_ADX', {
        executionPath: 'SKIPPED_FILTERS',
        signalParams: this.signalParams(candle, indicators),
      });
      return null;
    }

    const candleRange = candle.high - candle.low;
    if (candleRange > maxRangeAtr * indicators.atr) {
      this.logger.logSignal(symbol, side, 'SKIPPED_BLOWOFF_CANDLE', {
        executionPath: 'SKIPPED_FILTERS',
        details: { candleRange, atr: indicators.atr, ratio: candleRange / indicators.atr },
        signalParams: this.signalParams(candle, indicators),
      });
      return null;
    }

    return { side };
  }

  private isOnCooldown(symbol: string, side: Side): boolean {
    return this.cooldowns.some(
      c => c.symbol === symbol && c.side === side && (this.barIndex - c.stoppedAtBar) < this.config.cooldownBars,
    );
  }

  private addCooldown(symbol: string, side: Side, bar: number): void {
    this.cooldowns = this.cooldowns.filter(
      c => (this.barIndex - c.stoppedAtBar) < this.config.cooldownBars,
    );
    this.cooldowns.push({ symbol, side, stoppedAtBar: bar });
  }

  /** For sim/testing: force close all positions with a reason. */
  async forceCloseAll(reason: ExitReason, timestampMs: number): Promise<void> {
    for (const [, trade] of this.openTrades) {
      const positions = await this.exchange.getPositions();
      const pos = positions.find(p => p.symbol === trade.symbol);
      const exitPrice = pos?.markPrice ?? trade.entryPrice;
      await this.closeTradeWithReason(trade, reason, exitPrice, timestampMs);
    }
  }
}
