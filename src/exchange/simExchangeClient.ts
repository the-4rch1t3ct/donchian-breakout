import type { Candle, FillResult, OpenOrder, OrderBookTop, Position, Side } from '../types/index.js';
import type { IExchangeClient } from './exchangeClient.js';

interface SimPosition {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  leverage: number;
}

/**
 * Simulated exchange client for backtesting.
 * Feeds candles externally; executes fills at candle prices with configurable slippage.
 */
export class SimExchangeClient implements IExchangeClient {
  private equity: number;
  private cash: number;
  private positions: Map<string, SimPosition> = new Map();
  private orderIdCounter = 0;
  private pendingOrders: OpenOrder[] = [];
  private candleStore: Map<string, Candle[]> = new Map();
  private currentCandle: Map<string, Candle> = new Map();
  private slippageBps: number;
  private feeRate: number;

  constructor(
    initialEquity: number,
    slippageBps = 2,
    feeRate = 0.00035,
  ) {
    this.equity = initialEquity;
    this.cash = initialEquity;
    this.slippageBps = slippageBps;
    this.feeRate = feeRate;
  }

  feedCandles(symbol: string, candles: Candle[]): void {
    this.candleStore.set(symbol, candles);
  }

  setCurrentCandle(symbol: string, candle: Candle): void {
    this.currentCandle.set(symbol, candle);
  }

  async getOrderBookTop(symbol: string): Promise<OrderBookTop> {
    const c = this.currentCandle.get(symbol);
    if (!c) throw new Error(`No current candle for ${symbol}`);
    const mid = c.close;
    const halfSpread = mid * 0.0003;
    return {
      bestBid: mid - halfSpread,
      bestAsk: mid + halfSpread,
      bidSize: 1000,
      askSize: 1000,
      spreadBps: 6,
    };
  }

  async placeLimit(symbol: string, side: Side, price: number, size: number, _postOnly: boolean): Promise<FillResult> {
    const c = this.currentCandle.get(symbol);
    if (!c) return { filled: false };

    const canFill = side === 'long' ? price >= c.low : price <= c.high;
    if (!canFill) return { filled: false, orderId: String(++this.orderIdCounter) };

    const slip = price * (this.slippageBps / 10_000);
    const fillPrice = side === 'long' ? price + slip * 0.5 : price - slip * 0.5;
    const fees = fillPrice * size * this.feeRate;
    this.applyFill(symbol, side, size, fillPrice, fees);

    return {
      filled: true,
      orderId: String(this.orderIdCounter),
      fillPrice,
      fillSize: size,
      fees,
      slippageBps: Math.abs(fillPrice - price) / price * 10_000,
    };
  }

  async cancel(_orderId: string): Promise<void> {
    this.pendingOrders = [];
  }

  async placeMarketable(symbol: string, side: Side, size: number): Promise<FillResult> {
    const c = this.currentCandle.get(symbol);
    if (!c) return { filled: false };

    const slip = c.close * (this.slippageBps / 10_000);
    const fillPrice = side === 'long' ? c.close + slip : c.close - slip;
    const fees = fillPrice * size * this.feeRate;
    this.applyFill(symbol, side, size, fillPrice, fees);

    return {
      filled: true,
      orderId: String(++this.orderIdCounter),
      fillPrice,
      fillSize: size,
      fees,
      slippageBps: this.slippageBps,
    };
  }

  async getPositions(): Promise<Position[]> {
    const result: Position[] = [];
    for (const [, pos] of this.positions) {
      const c = this.currentCandle.get(pos.symbol);
      const markPrice = c?.close ?? pos.entryPrice;
      const pnlMult = pos.side === 'long' ? 1 : -1;
      const unrealizedPnl = (markPrice - pos.entryPrice) * pos.size * pnlMult;
      result.push({
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        markPrice,
        unrealizedPnl,
        leverage: pos.leverage,
      });
    }
    return result;
  }

  async getEquity(): Promise<number> {
    let unrealized = 0;
    for (const [, pos] of this.positions) {
      const c = this.currentCandle.get(pos.symbol);
      const markPrice = c?.close ?? pos.entryPrice;
      const pnlMult = pos.side === 'long' ? 1 : -1;
      unrealized += (markPrice - pos.entryPrice) * pos.size * pnlMult;
    }
    return this.cash + unrealized;
  }

  async getOpenOrders(_symbol?: string): Promise<OpenOrder[]> {
    return [...this.pendingOrders];
  }

  async cancelAll(_symbol?: string): Promise<void> {
    this.pendingOrders = [];
  }

  async closePosition(symbol: string, side: Side, size: number): Promise<FillResult> {
    const closeSide: Side = side === 'long' ? 'short' : 'long';
    return this.placeMarketable(symbol, closeSide, size);
  }

  async getCandles(symbol: string, _intervalMs: number, count: number): Promise<Candle[]> {
    const candles = this.candleStore.get(symbol) ?? [];
    return candles.slice(-count);
  }

  async getRecentCandles1m(symbol: string, count: number): Promise<Candle[]> {
    return this.getCandles(symbol, 60_000, count);
  }

  getCash(): number { return this.cash; }

  private applyFill(symbol: string, side: Side, size: number, fillPrice: number, fees: number): void {
    const existing = this.positions.get(symbol);

    if (existing && existing.side !== side) {
      const closedSize = Math.min(existing.size, size);
      const pnlMult = existing.side === 'long' ? 1 : -1;
      const pnl = (fillPrice - existing.entryPrice) * closedSize * pnlMult;
      this.cash += pnl - fees;

      existing.size -= closedSize;
      if (existing.size <= 1e-12) {
        this.positions.delete(symbol);
      }

      const remaining = size - closedSize;
      if (remaining > 1e-12) {
        this.positions.set(symbol, {
          symbol, side, size: remaining, entryPrice: fillPrice, leverage: 5,
        });
      }
    } else if (existing && existing.side === side) {
      const totalSize = existing.size + size;
      const avgEntry = (existing.entryPrice * existing.size + fillPrice * size) / totalSize;
      existing.entryPrice = avgEntry;
      existing.size = totalSize;
      this.cash -= fees;
    } else {
      this.positions.set(symbol, {
        symbol, side, size, entryPrice: fillPrice, leverage: 5,
      });
      this.cash -= fees;
    }
  }
}
