import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Config } from '../config.js';
import type { StrategyLogger } from '../logger.js';
import type { IExchangeClient } from '../exchange/exchangeClient.js';
import { atr } from '../indicators/atr.js';
import type { Side } from '../types/index.js';

export interface ProtectionMeta {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  opened_at: string;
  stopPx: number;
  tpPx: number;
  sl_orderId?: string;
  tp_orderId?: string;
  last_repaired_at?: string;
}

/**
 * Keeps on-exchange SL/TP in place.
 * - Writes meta to the shared Clawdbot positions file so ops-watchdog can alert.
 * - Can reconstruct SL/TP for positions after restarts.
 */
export class ProtectionService {
  private positionsFile: string;

  constructor(
    private config: Config,
    private logger: StrategyLogger,
    private exchange: IExchangeClient,
  ) {
    this.positionsFile = process.env.POSITIONS_FILE
      ?? '/home/botadmin/clawd/memory/hyperliquid-trading-positions.json';
  }

  private loadAll(): Record<string, any> {
    try {
      const raw = fs.readFileSync(this.positionsFile, 'utf-8');
      const data = JSON.parse(raw);
      return (data && typeof data === 'object') ? data : {};
    } catch {
      return {};
    }
  }

  private saveAll(data: Record<string, any>): void {
    const dir = path.dirname(this.positionsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.positionsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.positionsFile);
  }

  upsertMeta(symbol: string, meta: Partial<ProtectionMeta>): void {
    const all = this.loadAll();
    const existing = (all[symbol] && typeof all[symbol] === 'object') ? all[symbol] : {};
    all[symbol] = { ...existing, ...meta };
    this.saveAll(all);
  }

  /** Compute emergency stop/tp based on recent ATR when we don't have trade state. */
  private computeFallbackStopTp(entryPrice: number, side: Side, atrVal: number): { stopPx: number; tpPx: number } {
    const stopDist = this.config.stopAtrMult * atrVal;
    const R = stopDist;
    const stopPx = side === 'long' ? entryPrice - stopDist : entryPrice + stopDist;
    const tpPx = side === 'long'
      ? entryPrice + (this.config.tpRMultiple * R)
      : entryPrice - (this.config.tpRMultiple * R);
    return { stopPx, tpPx };
  }

  async ensureForPosition(params: {
    symbol: string;
    side: Side;
    size: number;
    entryPrice: number;
    stopPx?: number;
    tpPx?: number;
    nowIso?: string;
  }): Promise<void> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const symbol = params.symbol;

    // Pull existing meta if any
    const all = this.loadAll();
    const existing = (all[symbol] && typeof all[symbol] === 'object') ? all[symbol] : {};

    let stopPx = params.stopPx ?? existing.stopPx;
    let tpPx = params.tpPx ?? existing.tpPx;

    // If we still don't have a stop/tp, compute from recent ATR.
    if (!stopPx || !tpPx) {
      const candles = await this.exchange.getCandles(symbol, this.config.signalTimeframeMs, 60);
      const atrVal = candles.length >= this.config.atrLength + 2
        ? atr(candles, this.config.atrLength)
        : 0;
      if (atrVal <= 0) {
        this.logger.logEvent('RISK', 'TPSL_REPAIR_FAILED_NO_ATR', symbol, params.side, {
          details: { msg: 'Could not compute ATR for fallback TP/SL' },
        });
        return;
      }
      const fallback = this.computeFallbackStopTp(params.entryPrice, params.side, atrVal);
      stopPx = fallback.stopPx;
      tpPx = fallback.tpPx;
    }

    // Check open orders for existing SL/TP.
    const openOrders = await this.exchange.getOpenOrders(symbol);
    const openById = new Set(openOrders.map(o => o.orderId));

    // Prefer meta-linked orderIds if still open.
    let newSl = (existing.sl_orderId && openById.has(String(existing.sl_orderId)))
      ? String(existing.sl_orderId)
      : undefined;
    let newTp = (existing.tp_orderId && openById.has(String(existing.tp_orderId)))
      ? String(existing.tp_orderId)
      : undefined;

    // If HL doesn't tag TP/SL (tpsl === undefined), detect by triggerPx proximity.
    // Also prevents runaway duplicates if we restart and lose stored orderIds.
    const relTol = 0.002; // 20 bps; plenty for tick rounding + string formatting.
    const triggers = openOrders
      .filter(o => Boolean(o.isTrigger))
      .filter(o => o.reduceOnly)
      .filter(o => typeof o.triggerPx === 'number' && Number.isFinite(o.triggerPx));

    const isLong = params.side === 'long';

    function relDiff(a: number, b: number): number {
      return Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
    }

    function bestMatch(targetPx: number): { keep?: string; extras: string[] } {
      const matches = triggers
        .filter(o => relDiff(o.triggerPx as number, targetPx) <= relTol)
        .map(o => ({ id: o.orderId, d: relDiff(o.triggerPx as number, targetPx) }))
        .sort((x, y) => x.d - y.d);
      if (matches.length === 0) return { extras: [] };
      const keep = matches[0].id;
      const extras = matches.slice(1).map(m => m.id);
      return { keep, extras };
    }

    // Only attempt match if we don't already have ids.
    if (!newSl) {
      const m = bestMatch(stopPx);
      if (m.keep) newSl = m.keep;
      // cancel duplicate SLs at same triggerPx
      for (const id of m.extras) {
        try { await this.exchange.cancel(id); } catch { /* ignore */ }
      }
    }

    if (!newTp) {
      const m = bestMatch(tpPx);
      if (m.keep) newTp = m.keep;
      for (const id of m.extras) {
        try { await this.exchange.cancel(id); } catch { /* ignore */ }
      }
    }

    // Final safety: if HL returned multiple trigger orders but none match, don't spam new ones.
    // (Better to alert than to stack reduce-only triggers.)
    const triggerCount = triggers.length;

    // Repair missing orders.
    if (!newSl) {
      if (triggerCount >= 4) {
        this.logger.logEvent('RISK', 'TPSL_SKIPPED_TOO_MANY_TRIGGERS', symbol, params.side, {
          details: { triggerCount, stopPx, tpPx },
        });
      } else {
        const r = await this.exchange.placeTriggerTpsl(symbol, params.side, params.size, stopPx, 'sl');
        if (r.orderId) newSl = r.orderId;
      }
    }

    if (!newTp) {
      if (triggerCount >= 4) {
        this.logger.logEvent('RISK', 'TPSL_SKIPPED_TOO_MANY_TRIGGERS', symbol, params.side, {
          details: { triggerCount, stopPx, tpPx },
        });
      } else {
        const r = await this.exchange.placeTriggerTpsl(symbol, params.side, params.size, tpPx, 'tp');
        if (r.orderId) newTp = r.orderId;
      }
    }

    this.upsertMeta(symbol, {
      symbol,
      side: params.side,
      size: params.size,
      entryPrice: params.entryPrice,
      opened_at: existing.opened_at ?? nowIso,
      stopPx,
      tpPx,
      sl_orderId: newSl,
      tp_orderId: newTp,
      last_repaired_at: nowIso,
    });

    if (!newSl || !newTp) {
      this.logger.logEvent('RISK', 'TPSL_REPAIR_INCOMPLETE', symbol, params.side, {
        details: { slSet: Boolean(newSl), tpSet: Boolean(newTp), stopPx, tpPx },
      });
    } else {
      this.logger.logEvent('RISK', 'TPSL_OK', symbol, params.side, {
        details: { sl_orderId: newSl, tp_orderId: newTp, stopPx, tpPx },
      });
    }
  }

  /** Scan exchange for any open positions missing SL/TP and repair. */
  async scanAndRepair(): Promise<void> {
    const positions = await this.exchange.getPositions();

    for (const p of positions) {
      await this.ensureForPosition({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
      });
    }

    // Cancel orphan TP/SL trigger orders for symbols with no open position.
    // (HL can sometimes keep reduce-only TP/SL around; keep the account clean.)
    try {
      const liveSyms = new Set(positions.map(p => p.symbol));
      const openOrders = await this.exchange.getOpenOrders();
      const orphans = openOrders
        .filter(o => !liveSyms.has(o.symbol))
        .filter(o => Boolean(o.isTrigger))
        .filter(o => o.reduceOnly);

      for (const o of orphans) {
        try {
          await this.exchange.cancel(o.orderId);
          this.logger.logEvent('RISK', 'ORPHAN_TPSL_CANCELLED', o.symbol, o.side, {
            details: { orderId: o.orderId, tpsl: o.tpsl, triggerPx: o.triggerPx, price: o.price, size: o.size },
          });
        } catch (err) {
          this.logger.logEvent('RISK', 'ORPHAN_TPSL_CANCEL_ERROR', o.symbol, o.side, {
            details: { orderId: o.orderId, error: String(err) },
          });
        }
      }
    } catch (err) {
      this.logger.logEvent('RISK', 'ORPHAN_TPSL_SCAN_ERROR', '', '', {
        details: { error: String(err) },
      });
    }

    // Prune local file of positions that no longer exist on exchange.
    const all = this.loadAll();
    const liveSyms = new Set(positions.map(p => p.symbol));
    let changed = false;
    for (const sym of Object.keys(all)) {
      if (!liveSyms.has(sym)) {
        delete all[sym];
        changed = true;
      }
    }
    if (changed) this.saveAll(all);
  }
}
