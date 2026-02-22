import type { Candle } from '../types/index.js';

export interface DonchianResult {
  high: number;
  low: number;
  mid: number;
}

/**
 * Donchian Channel: highest high and lowest low over N periods.
 * Returns the channel computed from candles[0..N-1] (the N most recent COMPLETED candles,
 * excluding the current forming candle).
 */
export function donchian(candles: Candle[], length: number): DonchianResult {
  if (candles.length < length) {
    throw new Error(`Need at least ${length} candles, got ${candles.length}`);
  }
  const window = candles.slice(-length);
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low, mid: (high + low) / 2 };
}

/**
 * Compute full Donchian series for backtesting.
 * Returns an array aligned to candles (first length-1 entries are null).
 */
export function donchianSeries(candles: Candle[], length: number): (DonchianResult | null)[] {
  const result: (DonchianResult | null)[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < length - 1) {
      result.push(null);
    } else {
      result.push(donchian(candles.slice(0, i + 1), length));
    }
  }
  return result;
}
