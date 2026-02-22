import type { Candle } from '../types/index.js';

/**
 * True Range for a single candle given previous close.
 */
export function trueRange(candle: Candle, prevClose: number): number {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low - prevClose),
  );
}

/**
 * ATR using Wilder's smoothing (RMA).
 * Requires candles.length >= length + 1 (need prev close for TR).
 * Returns the ATR value for the most recent candle.
 */
export function atr(candles: Candle[], length: number): number {
  if (candles.length < length + 1) {
    throw new Error(`Need at least ${length + 1} candles for ATR(${length}), got ${candles.length}`);
  }

  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trValues.push(trueRange(candles[i], candles[i - 1].close));
  }

  let rma = 0;
  for (let i = 0; i < length; i++) {
    rma += trValues[i];
  }
  rma /= length;

  for (let i = length; i < trValues.length; i++) {
    rma = (rma * (length - 1) + trValues[i]) / length;
  }

  return rma;
}

/**
 * ATR series for backtesting. Returns array aligned to candles.
 * First `length` entries are null (need length+1 candles incl. prev close).
 */
export function atrSeries(candles: Candle[], length: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < length) {
      result.push(null);
    } else {
      result.push(atr(candles.slice(0, i + 1), length));
    }
  }
  return result;
}
