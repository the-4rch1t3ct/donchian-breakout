import {
  InfoClient,
  ExchangeClient as HlExchangeClient,
  HttpTransport,
} from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import type { IExchangeClient, PlaceMarketableOptions, TpslType } from './exchangeClient.js';
import type { Candle, FillResult, OpenOrder, OrderBookTop, Position, Side } from '../types/index.js';
import type { StrategyLogger } from '../logger.js';

const INTERVAL_MAP: Record<number, string> = {
  60_000: '1m',
  180_000: '3m',
  300_000: '5m',
  900_000: '15m',
  1_800_000: '30m',
  3_600_000: '1h',
  7_200_000: '2h',
  14_400_000: '4h',
  86_400_000: '1d',
};

type HlInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M';

function toHlInterval(intervalMs: number): HlInterval {
  return (INTERVAL_MAP[intervalMs] ?? '15m') as HlInterval;
}

export interface HlClientOptions {
  walletAddress: string;
  privateKey: string;
  baseUrl?: string;
  logger: StrategyLogger;
  minNotionalPerOrder: number;
  maxNotionalPerSymbol: number;
  takerFeeBps: number;
  makerFeeBps: number;
}

/**
 * Production Hyperliquid exchange client.
 * Uses @nktkas/hyperliquid SDK with viem wallet for EIP-712 signing.
 */
export class HyperliquidExchangeClient implements IExchangeClient {
  private info: InstanceType<typeof InfoClient>;
  private hl: InstanceType<typeof HlExchangeClient>;
  private walletAddress: `0x${string}`;
  private logger: StrategyLogger;
  private minNotionalPerOrder: number;
  private maxNotionalPerSymbol: number;
  private takerFeeBps: number;
  private makerFeeBps: number;

  private assetIndexMap = new Map<string, number>();
  private szDecimalsMap = new Map<string, number>();
  private orderAssetMap = new Map<string, number>(); // orderId → assetIndex for cancel

  constructor(opts: HlClientOptions) {
    this.walletAddress = opts.walletAddress as `0x${string}`;
    this.logger = opts.logger;
    this.minNotionalPerOrder = opts.minNotionalPerOrder;
    this.maxNotionalPerSymbol = opts.maxNotionalPerSymbol;
    this.takerFeeBps = opts.takerFeeBps;
    this.makerFeeBps = opts.makerFeeBps;

    const isTestnet = opts.baseUrl?.includes('testnet') ?? false;
    const transport = new HttpTransport({
      isTestnet,
      ...(opts.baseUrl ? { apiUrl: opts.baseUrl } : {}),
    });
    const wallet = privateKeyToAccount(opts.privateKey as `0x${string}`);

    this.info = new InfoClient({ transport });
    this.hl = new HlExchangeClient({
      transport,
      wallet,
      defaultVaultAddress: this.walletAddress,
    });
  }

  /** Must be called once before using the client. Fetches asset universe. */
  async init(): Promise<void> {
    const meta = await this.info.meta();
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i];
      this.assetIndexMap.set(asset.name, i);
      this.szDecimalsMap.set(asset.name, asset.szDecimals);
    }
    this.logger.logEvent('EXCHANGE', 'ASSET_MAP_LOADED', '', '', {
      details: { assetCount: meta.universe.length },
    });
  }

  private getAssetIndex(symbol: string): number {
    const idx = this.assetIndexMap.get(symbol);
    if (idx === undefined) throw new Error(`Unknown symbol: ${symbol}. Call init() first.`);
    return idx;
  }

  private roundSize(symbol: string, size: number): string {
    const dec = this.szDecimalsMap.get(symbol) ?? 4;
    return size.toFixed(dec);
  }

  private generateCloid(): `0x${string}` {
    const hex = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
    return `0x${hex}` as `0x${string}`;
  }

  private notionalGuard(symbol: string, price: number, size: number): boolean {
    const notional = price * size;
    if (notional < this.minNotionalPerOrder) {
      this.logger.logEvent('EXCHANGE', 'ORDER_BLOCKED_MIN_NOTIONAL', symbol, '', {
        details: { notional, min: this.minNotionalPerOrder, size, price },
      });
      return false;
    }
    if (notional > this.maxNotionalPerSymbol) {
      this.logger.logEvent('EXCHANGE', 'ORDER_BLOCKED_MAX_NOTIONAL', symbol, '', {
        details: { notional, max: this.maxNotionalPerSymbol, size, price },
      });
      return false;
    }
    return true;
  }

  async getOrderBookTop(symbol: string): Promise<OrderBookTop> {
    try {
      const book = await this.info.l2Book({ coin: symbol });
      if (!book) throw new Error(`No order book for ${symbol}`);

      const [bids, asks] = book.levels;
      const bestBid = bids.length > 0 ? parseFloat(bids[0].px) : 0;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].px) : 0;
      const bidSize = bids.length > 0 ? parseFloat(bids[0].sz) : 0;
      const askSize = asks.length > 0 ? parseFloat(asks[0].sz) : 0;
      const mid = (bestBid + bestAsk) / 2;
      const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

      return {
        bestBid,
        bestAsk,
        bidSize,
        askSize,
        spreadBps,
        timestamp: book.time,
      };
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, '', {
        details: { method: 'getOrderBookTop', error: String(err) },
      });
      throw err;
    }
  }

  async getMarkPrice(symbol: string): Promise<number> {
    try {
      const mids = await this.info.allMids();
      const priceStr = (mids as Record<string, string>)[symbol];
      if (!priceStr) throw new Error(`No mid price for ${symbol}`);
      return parseFloat(priceStr);
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, '', {
        details: { method: 'getMarkPrice', error: String(err) },
      });
      throw err;
    }
  }

  async placeLimit(
    symbol: string,
    side: Side,
    price: number,
    size: number,
    postOnly: boolean,
  ): Promise<FillResult> {
    if (!this.notionalGuard(symbol, price, size)) {
      return { filled: false };
    }

    const assetIndex = this.getAssetIndex(symbol);
    const cloid = this.generateCloid();
    const tif = postOnly ? 'Alo' as const : 'Gtc' as const;

    try {
      const result = await this.hl.order({
        orders: [{
          a: assetIndex,
          b: side === 'long',
          // Hyperliquid rejects too-many-decimals on low-priced coins (422 deserialize).
          p: price.toFixed(6),
          s: this.roundSize(symbol, size),
          r: false,
          t: { limit: { tif } },
          c: cloid,
        }],
        grouping: 'na',
      });

      const status = result.response.data.statuses[0] as Record<string, any>;
      // ORDER_PLACED/ORDER_FILLED are logged by ExecutionService with full audit context

      if (status && typeof status === 'object') {
        if ('filled' in status && status.filled) {
          const fill = status.filled;
          return {
            filled: true,
            orderId: String(fill.oid),
            fillPrice: parseFloat(fill.avgPx),
            fillSize: parseFloat(fill.totalSz),
            fees: parseFloat(fill.avgPx) * parseFloat(fill.totalSz) * (this.makerFeeBps / 10_000),
            slippageBps: Math.abs(parseFloat(fill.avgPx) - price) / price * 10_000,
          };
        }
        if ('resting' in status && status.resting) {
          const oid = String(status.resting.oid);
          this.orderAssetMap.set(oid, assetIndex);
          return { filled: false, orderId: oid };
        }
        if ('error' in status) {
          this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, side, {
            details: { method: 'placeLimit', error: String(status.error) },
          });
          return { filled: false };
        }
      }

      return { filled: false };
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, side, {
        details: { method: 'placeLimit', error: String(err) },
      });
      return { filled: false };
    }
  }

  async cancel(orderId: string): Promise<void> {
    const assetIndex = this.orderAssetMap.get(orderId);
    if (assetIndex === undefined) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'cancel', error: `No asset index for order ${orderId}` },
      });
      return;
    }

    try {
      await this.hl.cancel({
        cancels: [{ a: assetIndex, o: parseInt(orderId, 10) }],
      });
      this.orderAssetMap.delete(orderId);
      // ORDER_CANCELLED is logged by ExecutionService with reason
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'cancel', error: String(err), orderId },
      });
    }
  }

  async placeMarketable(
    symbol: string,
    side: Side,
    size: number,
    options?: PlaceMarketableOptions,
  ): Promise<FillResult> {
    const book = await this.getOrderBookTop(symbol);
    const maxSlippageBps = options?.maxSlippageBps ?? this.takerFeeBps * 2;
    const slipMult = maxSlippageBps / 10_000;
    const price = side === 'long'
      ? book.bestAsk * (1 + slipMult)
      : book.bestBid * (1 - slipMult);

    if (!this.notionalGuard(symbol, price, size)) {
      return { filled: false };
    }

    const assetIndex = this.getAssetIndex(symbol);
    const cloid = this.generateCloid();

    try {
      const result = await this.hl.order({
        orders: [{
          a: assetIndex,
          b: side === 'long',
          p: price.toFixed(6),
          s: this.roundSize(symbol, size),
          r: false,
          t: { limit: { tif: 'Ioc' as const } },
          c: cloid,
        }],
        grouping: 'na',
      });

      const status = result.response.data.statuses[0] as Record<string, any>;
      // ORDER_PLACED / ORDER_FILLED / ORDER_FAILED are logged by ExecutionService

      if (status && typeof status === 'object' && 'filled' in status && status.filled) {
        const fill = status.filled;
        return {
          filled: true,
          orderId: String(fill.oid),
          fillPrice: parseFloat(fill.avgPx),
          fillSize: parseFloat(fill.totalSz),
          fees: parseFloat(fill.avgPx) * parseFloat(fill.totalSz) * (this.takerFeeBps / 10_000),
          slippageBps: Math.abs(parseFloat(fill.avgPx) - (side === 'long' ? book.bestAsk : book.bestBid)) / (side === 'long' ? book.bestAsk : book.bestBid) * 10_000,
        };
      }

      return { filled: false };
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, side, {
        details: { method: 'placeMarketable', error: String(err) },
      });
      return { filled: false };
    }
  }

  async placeTriggerTpsl(
    symbol: string,
    positionSide: Side,
    size: number,
    triggerPx: number,
    tpsl: TpslType,
  ): Promise<{ orderId?: string }> {
    // Close side is opposite of current position.
    const closeSide: Side = positionSide === 'long' ? 'short' : 'long';
    const assetIndex = this.getAssetIndex(symbol);
    const cloid = this.generateCloid();

    try {
      const result = await this.hl.order({
        orders: [{
          a: assetIndex,
          b: closeSide === 'long',
          // SDK schema requires p>0 even for trigger orders; use triggerPx.
          p: triggerPx.toFixed(6),
          s: this.roundSize(symbol, size),
          r: true, // reduce-only
          t: { trigger: { isMarket: true, triggerPx: triggerPx.toFixed(6), tpsl } },
          c: cloid,
        }],
        // Make it follow position size changes.
        grouping: 'positionTpsl',
      });

      const status = result.response.data.statuses[0] as any;

      // Success variants that return an oid directly.
      if (status && typeof status === 'object' && status.resting) {
        return { orderId: String(status.resting.oid) };
      }
      if (status && typeof status === 'object' && status.filled) {
        return { orderId: String(status.filled.oid) };
      }

      // Trigger orders may return the literal "waitingForTrigger".
      // In that case, fetch open orders and try to locate the new order by fields.
      if (status === 'waitingForTrigger') {
        try {
          const open = await this.info.frontendOpenOrders({ user: this.walletAddress });
          const cands = open
            .filter((o: any) => o.coin === symbol)
            .filter((o: any) => Boolean(o.isTrigger))
            .filter((o: any) => (o.tpsl === tpsl))
            .filter((o: any) => {
              const tp = o.triggerPx != null ? parseFloat(o.triggerPx) : NaN;
              return Number.isFinite(tp) && Math.abs(tp - triggerPx) / triggerPx < 0.001; // 0.1% tolerance
            });
          if (cands.length > 0) {
            // newest/highest oid is most likely ours
            const best = cands.sort((a: any, b: any) => (b.oid ?? 0) - (a.oid ?? 0))[0];
            return { orderId: String(best.oid) };
          }
        } catch (err) {
          this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, positionSide, {
            details: { method: 'placeTriggerTpsl_followup', error: String(err), tpsl, triggerPx },
          });
        }
        return {};
      }

      if (status && typeof status === 'object' && 'error' in status) {
        this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, positionSide, {
          details: { method: 'placeTriggerTpsl', error: String(status.error), tpsl, triggerPx },
        });
        return {};
      }

      // Unknown status: log for debugging.
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, positionSide, {
        details: { method: 'placeTriggerTpsl', error: 'Unknown order status', status, tpsl, triggerPx },
      });
      return {};
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, positionSide, {
        details: { method: 'placeTriggerTpsl', error: String(err), tpsl, triggerPx },
      });
      return {};
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const state = await this.info.clearinghouseState({ user: this.walletAddress });
      const positions: Position[] = [];

      for (const ap of state.assetPositions) {
        const pos = ap.position;
        const szi = parseFloat(pos.szi);
        if (Math.abs(szi) < 1e-12) continue;

        positions.push({
          symbol: pos.coin,
          side: szi > 0 ? 'long' : 'short',
          size: Math.abs(szi),
          entryPrice: parseFloat(pos.entryPx),
          markPrice: parseFloat(pos.positionValue) / Math.abs(szi),
          unrealizedPnl: parseFloat(pos.unrealizedPnl),
          leverage: pos.leverage.value,
        });
      }

      return positions;
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'getPositions', error: String(err) },
      });
      return [];
    }
  }

  async getEquity(): Promise<number> {
    try {
      const [perpsState, spotState] = await Promise.all([
        this.info.clearinghouseState({ user: this.walletAddress }),
        this.info.spotClearinghouseState({ user: this.walletAddress }),
      ]);

      const perpsAccountValue = parseFloat(perpsState.crossMarginSummary.accountValue);

      let spotUsdcBalance = 0;
      for (const bal of spotState.balances) {
        if (bal.coin === 'USDC') {
          spotUsdcBalance = parseFloat(bal.total);
          break;
        }
      }

      const totalEquity = perpsAccountValue + spotUsdcBalance;

      this.logger.logEvent('EXCHANGE', 'EQUITY_QUERY', '', '', {
        details: { perpsAccountValue, spotUsdcBalance, totalEquity },
      });

      return totalEquity;
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'getEquity', error: String(err) },
      });
      throw err;
    }
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    try {
      // Use frontendOpenOrders so we can see triggerPx + TP/SL info.
      const orders = await this.info.frontendOpenOrders({ user: this.walletAddress });
      const mapped: OpenOrder[] = [];

      for (const o of orders) {
        if (symbol && o.coin !== symbol) continue;
        const oid = String(o.oid);
        const assetIdx = this.assetIndexMap.get(o.coin);
        if (assetIdx !== undefined) this.orderAssetMap.set(oid, assetIdx);

        mapped.push({
          orderId: oid,
          symbol: o.coin,
          side: o.side === 'B' ? 'long' : 'short',
          price: parseFloat(o.limitPx),
          size: parseFloat(o.sz),
          postOnly: false, // not exposed in this response
          reduceOnly: Boolean((o as any).reduceOnly ?? (o as any).isReduceOnly),
          isTrigger: Boolean((o as any).isTrigger),
          triggerPx: (o as any).triggerPx != null ? parseFloat((o as any).triggerPx) : undefined,
          tpsl: ((o as any).tpsl === 'tp' || (o as any).tpsl === 'sl') ? (o as any).tpsl : undefined,
        });
      }

      return mapped;
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'getOpenOrders', error: String(err) },
      });
      return [];
    }
  }

  async cancelAll(symbol?: string): Promise<void> {
    try {
      const orders = await this.getOpenOrders(symbol);
      if (orders.length === 0) return;

      const cancels = orders.map(o => ({
        a: this.getAssetIndex(o.symbol),
        o: parseInt(o.orderId, 10),
      }));

      await this.hl.cancel({ cancels });

      for (const o of orders) {
        this.orderAssetMap.delete(o.orderId);
      }

      this.logger.logEvent('EXCHANGE', 'ORDER_CANCELLED', symbol ?? '', '', {
        details: { count: orders.length },
      });
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', '', '', {
        details: { method: 'cancelAll', error: String(err) },
      });
    }
  }

  async closePosition(symbol: string, side: Side, size: number): Promise<FillResult> {
    const book = await this.getOrderBookTop(symbol);
    const slipMult = 1 + (100 / 10_000); // 100 bps generous slippage for close
    const closeSide: Side = side === 'long' ? 'short' : 'long';
    const price = closeSide === 'long'
      ? book.bestAsk * slipMult
      : book.bestBid / slipMult;

    const assetIndex = this.getAssetIndex(symbol);
    const cloid = this.generateCloid();

    try {
      const result = await this.hl.order({
        orders: [{
          a: assetIndex,
          b: closeSide === 'long',
          p: price.toFixed(6),
          s: this.roundSize(symbol, size),
          r: true, // reduce-only
          t: { limit: { tif: 'Ioc' as const } },
          c: cloid,
        }],
        grouping: 'na',
      });

      const status = result.response.data.statuses[0] as Record<string, any>;
      if (status && typeof status === 'object' && 'filled' in status && status.filled) {
        const fill = status.filled;
        this.logger.logEvent('EXCHANGE', 'ORDER_FILLED', symbol, side, {
          details: { type: 'close_ioc', avgPx: fill.avgPx, totalSz: fill.totalSz },
        });
        return {
          filled: true,
          orderId: String(fill.oid),
          fillPrice: parseFloat(fill.avgPx),
          fillSize: parseFloat(fill.totalSz),
          fees: parseFloat(fill.avgPx) * parseFloat(fill.totalSz) * (this.takerFeeBps / 10_000),
        };
      }

      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, side, {
        details: { method: 'closePosition', msg: 'IOC not filled', status },
      });
      return { filled: false };
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, side, {
        details: { method: 'closePosition', error: String(err) },
      });
      return { filled: false };
    }
  }

  async getCandles(symbol: string, intervalMs: number, count: number): Promise<Candle[]> {
    try {
      const interval = toHlInterval(intervalMs);
      const endTime = Date.now();
      const startTime = endTime - count * intervalMs;

      const raw = await this.info.candleSnapshot({
        coin: symbol,
        interval,
        startTime,
        endTime,
      });

      return raw.map((c: { t: number; o: string; h: string; l: string; c: string; v: string }) => ({
        timestamp: c.t,
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
      }));
    } catch (err) {
      this.logger.logEvent('EXCHANGE', 'EXCHANGE_API_ERROR', symbol, '', {
        details: { method: 'getCandles', error: String(err) },
      });
      return [];
    }
  }

  async getRecentCandles1m(symbol: string, count: number): Promise<Candle[]> {
    return this.getCandles(symbol, 60_000, count);
  }
}
