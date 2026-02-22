import type { Candle } from '../types/index.js';
import { trueRange } from './atr.js';

/**
 * ADX (Average Directional Index) using Wilder's smoothing.
 * Requires candles.length >= 2 * length + 1 for a fully warmed ADX.
 */
export function adx(candles: Candle[], length: number): number {
  const minCandles = 2 * length + 1;
  if (candles.length < minCandles) {
    throw new Error(`Need at least ${minCandles} candles for ADX(${length}), got ${candles.length}`);
  }

  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(trueRange(candles[i], candles[i - 1].close));
  }

  const rma = (values: number[]): number[] => {
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < length; i++) sum += values[i];
    result.push(sum / length);
    for (let i = length; i < values.length; i++) {
      result.push((result[result.length - 1] * (length - 1) + values[i]) / length);
    }
    return result;
  };

  const smoothPlusDm = rma(plusDm);
  const smoothMinusDm = rma(minusDm);
  const smoothTr = rma(tr);

  const dx: number[] = [];
  for (let i = 0; i < smoothPlusDm.length; i++) {
    const atr = smoothTr[i];
    if (atr === 0) { dx.push(0); continue; }
    const plusDi = (smoothPlusDm[i] / atr) * 100;
    const minusDi = (smoothMinusDm[i] / atr) * 100;
    const diSum = plusDi + minusDi;
    dx.push(diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100);
  }

  if (dx.length < length) {
    throw new Error(`Insufficient DX values for ADX smoothing`);
  }

  let adxVal = 0;
  for (let i = 0; i < length; i++) adxVal += dx[i];
  adxVal /= length;

  for (let i = length; i < dx.length; i++) {
    adxVal = (adxVal * (length - 1) + dx[i]) / length;
  }

  return adxVal;
}

/**
 * ADX series for backtesting. Returns array aligned to candles.
 */
export function adxSeries(candles: Candle[], length: number): (number | null)[] {
  const minCandles = 2 * length + 1;
  const result: (number | null)[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < minCandles - 1) {
      result.push(null);
    } else {
      result.push(adx(candles.slice(0, i + 1), length));
    }
  }
  return result;
}
