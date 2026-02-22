import type { Candle } from '../src/types/index.js';

export function makeCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
): Candle {
  return { timestamp, open, high, low, close, volume };
}

/**
 * Generate a sequence of candles with controlled high/low from a price series.
 * prices: array of close prices.
 * Highs = close * (1 + halfRange), Lows = close * (1 - halfRange).
 */
export function makeCandleSeries(
  prices: number[],
  startTimestamp = 0,
  intervalMs = 15 * 60 * 1000,
  halfRangePct = 0.005,
): Candle[] {
  return prices.map((close, i) => {
    const open = i > 0 ? prices[i - 1] : close;
    const high = Math.max(open, close) * (1 + halfRangePct);
    const low = Math.min(open, close) * (1 - halfRangePct);
    return makeCandle(
      startTimestamp + i * intervalMs,
      open,
      high,
      low,
      close,
    );
  });
}
