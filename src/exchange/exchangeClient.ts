import type { Candle, FillResult, OpenOrder, OrderBookTop, Position, Side } from '../types/index.js';

export interface PlaceMarketableOptions {
  /** Max slippage in bps for IOC fallback (e.g. 8 = 0.08%). */
  maxSlippageBps?: number;
}

/**
 * Abstract exchange client interface.
 * Implementations: HyperliquidExchangeClient (live), PaperExchangeClient, SimExchangeClient.
 */
export interface IExchangeClient {
  getOrderBookTop(symbol: string): Promise<OrderBookTop>;
  getMarkPrice(symbol: string): Promise<number>;
  placeLimit(symbol: string, side: Side, price: number, size: number, postOnly: boolean): Promise<FillResult>;
  cancel(orderId: string): Promise<void>;
  placeMarketable(symbol: string, side: Side, size: number, options?: PlaceMarketableOptions): Promise<FillResult>;
  getPositions(): Promise<Position[]>;
  getEquity(): Promise<number>;
  getOpenOrders(symbol?: string): Promise<OpenOrder[]>;
  cancelAll(symbol?: string): Promise<void>;
  closePosition(symbol: string, side: Side, size: number): Promise<FillResult>;
  getCandles(symbol: string, intervalMs: number, count: number): Promise<Candle[]>;
  getRecentCandles1m(symbol: string, count: number): Promise<Candle[]>;
}
