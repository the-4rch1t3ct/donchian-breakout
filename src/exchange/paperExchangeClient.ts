import * as fs from 'node:fs';
import * as path from 'node:path';
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid';
import type { IExchangeClient, PlaceMarketableOptions } from './exchangeClient.js';
import type { Candle, FillResult, OpenOrder, OrderBookTop, Position, Side } from '../types/index.js';
import type { StrategyLogger } from '../logger.js';

interface PaperPosition {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  leverage: number;
}

interface PaperState {
  cash: number;
  positions: Record<string, PaperPosition>;
  orderIdCounter: number;
}

export interface PaperClientOptions {
  statePath: string;
  initialEquity: number;
  baseUrl?: string;
  logger: StrategyLogger;
  slippageBps?: number;
  takerFeeBps?: number;
  makerFeeBps?: number;
}

/**
 * Paper trading client: live market data from Hyperliquid, simulated fills + ledger.
 * State persists to a JSON file so restarts don't reset the account.
 */
export class PaperExchangeClient implements IExchangeClient {
  private info: InstanceType<typeof InfoClient>;
  private logger: StrategyLogger;
  private statePath: string;
  private state: PaperState;
  private slippageBps: number;
  private takerFeeBps: number;
  private makerFeeBps: number;

  private latestPrices = new Map<string, number>();

  constructor(opts: PaperClientOptions) {
    this.logger = opts.logger;
    this.statePath = opts.statePath;
    this.slippageBps = opts.slippageBps ?? 2;
    this.takerFeeBps = opts.takerFeeBps ?? 3.5;
    this.makerFeeBps = opts.makerFeeBps ?? 1.0;

    const isTestnet = opts.baseUrl?.includes('testnet') ?? false;
    const transport = new HttpTransport({
      isTestnet,
      ...(opts.baseUrl ? { apiUrl: opts.baseUrl } : {}),
    });
    this.info = new InfoClient({ transport });

    this.state = this.loadState(opts.initialEquity);
  }

  private loadState(initialEquity: number): PaperState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8');
        const loaded = JSON.parse(raw) as PaperState;
        this.logger.logEvent('RUNNER', 'PAPER_STATE_LOADED', '', '', {
          details: { cash: loaded.cash, positionCount: Object.keys(loaded.positions).length },
        });
        return loaded;
      }
    } catch (err) {
      this.logger.logEvent('RUNNER', 'PAPER_STATE_LOAD_ERROR', '', '', {
        details: { error: String(err) },
      });
    }
    return { cash: initialEquity, positions: {}, orderIdCounter: 0 };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.logger.logEvent('RUNNER', 'PAPER_STATE_SAVE_ERROR', '', '', {
        details: { error: String(err) },
      });
    }
  }

  private nextOrderId(): string {
    return String(++this.state.orderIdCounter);
  }

  async getOrderBookTop(symbol: string): Promise<OrderBookTop> {
    const book = await this.info.l2Book({ coin: symbol });
    if (!book) throw new Error(`No order book for ${symbol}`);

    const [bids, asks] = book.levels;
    const bestBid = bids.length > 0 ? parseFloat(bids[0].px) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].px) : 0;
    const bidSize = bids.length > 0 ? parseFloat(bids[0].sz) : 0;
    const askSize = asks.length > 0 ? parseFloat(asks[0].sz) : 0;
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

    this.latestPrices.set(symbol, mid);

    return { bestBid, bestAsk, bidSize, askSize, spreadBps, timestamp: book.time };
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const mids = await this.info.allMids();
    const priceStr = (mids as Record<string, string>)[symbol];
    if (!priceStr) throw new Error(`No mid price for ${symbol}`);
    const price = parseFloat(priceStr);
    this.latestPrices.set(symbol, price);
    return price;
  }

  async placeLimit(
    symbol: string,
    side: Side,
    price: number,
    size: number,
    _postOnly: boolean,
  ): Promise<FillResult> {
    const mid = this.latestPrices.get(symbol) ?? await this.getMarkPrice(symbol);
    const canFill = side === 'long' ? price >= mid * 0.999 : price <= mid * 1.001;

    if (!canFill) {
      return { filled: false, orderId: this.nextOrderId() };
    }

    const slip = price * (this.slippageBps / 10_000);
    const fillPrice = side === 'long' ? price + slip * 0.5 : price - slip * 0.5;
    const fees = fillPrice * size * (this.makerFeeBps / 10_000);
    this.applyFill(symbol, side, size, fillPrice, fees);

    return {
      filled: true,
      orderId: this.nextOrderId(),
      fillPrice,
      fillSize: size,
      fees,
      slippageBps: Math.abs(fillPrice - price) / price * 10_000,
    };
  }

  async cancel(_orderId: string): Promise<void> {
    // Paper: no resting orders to cancel
  }

  async placeMarketable(
    symbol: string,
    side: Side,
    size: number,
    _options?: PlaceMarketableOptions,
  ): Promise<FillResult> {
    const mid = this.latestPrices.get(symbol) ?? await this.getMarkPrice(symbol);
    const slip = mid * (this.slippageBps / 10_000);
    const fillPrice = side === 'long' ? mid + slip : mid - slip;
    const fees = fillPrice * size * (this.takerFeeBps / 10_000);
    this.applyFill(symbol, side, size, fillPrice, fees);

    return {
      filled: true,
      orderId: this.nextOrderId(),
      fillPrice,
      fillSize: size,
      fees,
      slippageBps: this.slippageBps,
    };
  }

  async getPositions(): Promise<Position[]> {
    const result: Position[] = [];
    for (const [, pos] of Object.entries(this.state.positions)) {
      const markPrice = this.latestPrices.get(pos.symbol) ?? pos.entryPrice;
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
    for (const [, pos] of Object.entries(this.state.positions)) {
      const markPrice = this.latestPrices.get(pos.symbol) ?? pos.entryPrice;
      const pnlMult = pos.side === 'long' ? 1 : -1;
      unrealized += (markPrice - pos.entryPrice) * pos.size * pnlMult;
    }
    return this.state.cash + unrealized;
  }

  async getOpenOrders(_symbol?: string): Promise<OpenOrder[]> {
    return []; // paper: no resting orders
  }

  async cancelAll(_symbol?: string): Promise<void> {
    // paper: no resting orders
  }

  async closePosition(symbol: string, side: Side, size: number): Promise<FillResult> {
    const closeSide: Side = side === 'long' ? 'short' : 'long';
    return this.placeMarketable(symbol, closeSide, size);
  }

  async getCandles(symbol: string, intervalMs: number, count: number): Promise<Candle[]> {
    type HlInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M';
    const intervalMap: Record<number, HlInterval> = {
      60_000: '1m', 180_000: '3m', 300_000: '5m', 900_000: '15m',
      1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d',
    };
    const interval: HlInterval = intervalMap[intervalMs] ?? '15m';
    const endTime = Date.now();
    const startTime = endTime - count * intervalMs;

    const raw = await this.info.candleSnapshot({ coin: symbol, interval, startTime, endTime });

    return raw.map((c: { t: number; o: string; h: string; l: string; c: string; v: string }) => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }));
  }

  async getRecentCandles1m(symbol: string, count: number): Promise<Candle[]> {
    return this.getCandles(symbol, 60_000, count);
  }

  /** Refresh live prices for all held positions. */
  async refreshPrices(): Promise<void> {
    try {
      const mids = await this.info.allMids();
      for (const [coin, priceStr] of Object.entries(mids as Record<string, string>)) {
        this.latestPrices.set(coin, parseFloat(priceStr));
      }
    } catch {
      // non-fatal
    }
  }

  private applyFill(symbol: string, side: Side, size: number, fillPrice: number, fees: number): void {
    const existing = this.state.positions[symbol];

    if (existing && existing.side !== side) {
      const closedSize = Math.min(existing.size, size);
      const pnlMult = existing.side === 'long' ? 1 : -1;
      const pnl = (fillPrice - existing.entryPrice) * closedSize * pnlMult;
      this.state.cash += pnl - fees;

      existing.size -= closedSize;
      if (existing.size <= 1e-12) {
        delete this.state.positions[symbol];
      }

      const remaining = size - closedSize;
      if (remaining > 1e-12) {
        this.state.positions[symbol] = {
          symbol, side, size: remaining, entryPrice: fillPrice, leverage: 5,
        };
      }
    } else if (existing && existing.side === side) {
      const totalSize = existing.size + size;
      const avgEntry = (existing.entryPrice * existing.size + fillPrice * size) / totalSize;
      existing.entryPrice = avgEntry;
      existing.size = totalSize;
      this.state.cash -= fees;
    } else {
      this.state.positions[symbol] = {
        symbol, side, size, entryPrice: fillPrice, leverage: 5,
      };
      this.state.cash -= fees;
    }

    this.saveState();
  }
}
