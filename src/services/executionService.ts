import type { Config } from '../config.js';
import type { StrategyLogger } from '../logger.js';
import type { IExchangeClient } from '../exchange/exchangeClient.js';
import type { Candle, ExecutionPath, FillResult, Side } from '../types/index.js';

/** Audit-grade order log details (no secrets). */
export type OrderLogReason =
  | 'ENTRY'
  | 'STOP'
  | 'TRAIL'
  | 'FLATTEN_ALL'
  | 'KILL_SWITCH'
  | 'CANCEL_TIMEOUT'
  | 'MAKER_TIMEOUT_IOC';

export interface MicrostructureCheck {
  pass: boolean;
  reason?: string;
  spreadBps: number;
  estimatedSlippageBps: number;
}

export class ExecutionService {
  constructor(
    private config: Config,
    private logger: StrategyLogger,
    private exchange: IExchangeClient,
  ) {}

  async checkMicrostructure(symbol: string): Promise<MicrostructureCheck> {
    const book = await this.exchange.getOrderBookTop(symbol);

    if (book.spreadBps > this.config.maxSpreadBps) {
      return {
        pass: false,
        reason: `spread ${book.spreadBps.toFixed(1)} bps > max ${this.config.maxSpreadBps}`,
        spreadBps: book.spreadBps,
        estimatedSlippageBps: book.spreadBps / 2,
      };
    }

    const estimatedSlippage = book.spreadBps / 2;
    if (estimatedSlippage > this.config.maxSlippageBps) {
      return {
        pass: false,
        reason: `slippage est ${estimatedSlippage.toFixed(1)} bps > max ${this.config.maxSlippageBps}`,
        spreadBps: book.spreadBps,
        estimatedSlippageBps: estimatedSlippage,
      };
    }

    const recent1m = await this.exchange.getRecentCandles1m(symbol, this.config.volatilityLookbackMinutes);
    const atr1m = this.computeSimpleAtr1m(recent1m);

    if (atr1m > 0) {
      for (const c of recent1m) {
        const range = c.high - c.low;
        if (range > this.config.maxMinuteRangeAtrMult * atr1m) {
          return {
            pass: false,
            reason: `volatility shock: 1m range ${range.toFixed(4)} > ${this.config.maxMinuteRangeAtrMult}*ATR1m ${(this.config.maxMinuteRangeAtrMult * atr1m).toFixed(4)}`,
            spreadBps: book.spreadBps,
            estimatedSlippageBps: estimatedSlippage,
          };
        }
      }
    }

    return {
      pass: true,
      spreadBps: book.spreadBps,
      estimatedSlippageBps: estimatedSlippage,
    };
  }

  private computeSimpleAtr1m(candles: Candle[]): number {
    if (candles.length < 2) return 0;
    let sum = 0;
    for (const c of candles) {
      sum += c.high - c.low;
    }
    return sum / candles.length;
  }

  private logOrderEvent(
    event: string,
    symbol: string,
    side: Side,
    details: Record<string, unknown>,
  ): void {
    this.logger.logEvent('EXCHANGE', event, symbol, side, { details });
  }

  /**
   * Attempt entry: maker-first (short timeout), then IOC marketable limit with slippage cap.
   * All order actions are logged for audit (ORDER_PLACED, ORDER_CANCELLED, ORDER_FILLED, ORDER_FAILED).
   */
  async executeEntry(
    symbol: string,
    side: Side,
    size: number,
    currentPrice: number,
  ): Promise<{ path: ExecutionPath; fill: FillResult }> {
    const micro = await this.checkMicrostructure(symbol);
    if (!micro.pass) {
      this.logger.logSignal(symbol, side, 'ENTRY_BLOCKED_MICROSTRUCTURE', {
        executionPath: 'SKIPPED_BAD_MICROSTRUCTURE',
        spreadBps: micro.spreadBps,
        slippageBps: micro.estimatedSlippageBps,
        details: { reason: micro.reason },
      });
      return {
        path: 'SKIPPED_BAD_MICROSTRUCTURE',
        fill: { filled: false },
      };
    }

    const book = await this.exchange.getOrderBookTop(symbol);
    const improveBps = this.config.makerImproveBps / 10_000;
    const makerPrice = side === 'long'
      ? book.bestBid * (1 + improveBps)
      : book.bestAsk * (1 - improveBps);
    const notional = makerPrice * size;

    this.logOrderEvent('ORDER_PLACED', symbol, side, {
      orderType: 'LIMIT_MAKER',
      postOnly: true,
      ioc: false,
      price: makerPrice,
      size,
      notional,
      cloid: null,
      orderId: null,
      reason: 'ENTRY',
      spreadBps: micro.spreadBps,
      estSlippageBps: micro.estimatedSlippageBps,
      attempt: 1,
    });
    const makerResult = await this.exchange.placeLimit(symbol, side, makerPrice, size, true);

    if (makerResult.filled && makerResult.fillPrice != null && makerResult.fillSize != null) {
      this.logOrderEvent('ORDER_FILLED', symbol, side, {
        orderType: 'LIMIT_MAKER',
        postOnly: true,
        ioc: false,
        price: makerPrice,
        size,
        notional,
        orderId: makerResult.orderId ?? null,
        reason: 'ENTRY',
        attempt: 1,
        fillPrice: makerResult.fillPrice,
        fillSize: makerResult.fillSize,
        fees: makerResult.fees ?? null,
        slippageBps: makerResult.slippageBps ?? null,
      });
      this.logger.logSignal(symbol, side, 'MAKER_FILLED', {
        executionPath: 'MAKER_FILLED',
        spreadBps: micro.spreadBps,
        slippageBps: makerResult.slippageBps,
        fees: makerResult.fees,
      });
      return { path: 'MAKER_FILLED', fill: makerResult };
    }

    if (makerResult.orderId) {
      await this.sleep(this.config.makerTimeoutMs);
      this.logOrderEvent('ORDER_CANCELLED', symbol, side, {
        orderId: makerResult.orderId,
        reason: 'CANCEL_TIMEOUT',
        attempt: 1,
      });
      await this.exchange.cancel(makerResult.orderId);
    }

    const microRecheck = await this.checkMicrostructure(symbol);
    if (!microRecheck.pass) {
      this.logger.logSignal(symbol, side, 'TAKER_BLOCKED_MICROSTRUCTURE', {
        executionPath: 'SKIPPED_BAD_MICROSTRUCTURE',
        details: { reason: microRecheck.reason },
      });
      return {
        path: 'SKIPPED_BAD_MICROSTRUCTURE',
        fill: { filled: false },
      };
    }

    const iocSlippageBps = this.config.iocMaxSlippageBps;
    this.logOrderEvent('ORDER_PLACED', symbol, side, {
      orderType: 'LIMIT_IOC',
      postOnly: false,
      ioc: true,
      price: null,
      size,
      notional: (side === 'long' ? book.bestAsk : book.bestBid) * size,
      cloid: null,
      orderId: null,
      reason: 'ENTRY',
      spreadBps: microRecheck.spreadBps,
      estSlippageBps: microRecheck.estimatedSlippageBps,
      attempt: 2,
      maxSlippageBps: iocSlippageBps,
    });
    const takerResult = await this.exchange.placeMarketable(symbol, side, size, {
      maxSlippageBps: iocSlippageBps,
    });

    if (takerResult.filled && takerResult.fillPrice != null && takerResult.fillSize != null) {
      this.logOrderEvent('ORDER_FILLED', symbol, side, {
        orderType: 'LIMIT_IOC',
        ioc: true,
        size,
        orderId: takerResult.orderId ?? null,
        reason: 'ENTRY',
        attempt: 2,
        fillPrice: takerResult.fillPrice,
        fillSize: takerResult.fillSize,
        fees: takerResult.fees ?? null,
        slippageBps: takerResult.slippageBps ?? null,
      });
      this.logger.logSignal(symbol, side, 'TAKER_FILLED_AFTER_MAKER_TIMEOUT', {
        executionPath: 'MAKER_TIMEOUT_TAKER',
        spreadBps: microRecheck.spreadBps,
        slippageBps: takerResult.slippageBps,
        fees: takerResult.fees,
      });
      return { path: 'MAKER_TIMEOUT_TAKER', fill: takerResult };
    }

    this.logOrderEvent('ORDER_FAILED', symbol, side, {
      orderType: 'LIMIT_IOC',
      reason: 'ENTRY',
      attempt: 2,
      details: 'IOC unfilled or rejected',
    });
    this.logger.logSignal(symbol, side, 'NO_FILL', {
      executionPath: 'SKIPPED_NO_FILL',
    });
    return { path: 'SKIPPED_NO_FILL', fill: { filled: false } };
  }

  /**
   * Simplified execute for sim (no maker/taker distinction, instant fill).
   */
  async executeEntrySim(
    symbol: string,
    side: Side,
    size: number,
    price: number,
  ): Promise<{ path: ExecutionPath; fill: FillResult }> {
    const result = await this.exchange.placeMarketable(symbol, side, size);
    const path: ExecutionPath = result.filled ? 'MAKER_FILLED' : 'SKIPPED_NO_FILL';
    return { path, fill: result };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
