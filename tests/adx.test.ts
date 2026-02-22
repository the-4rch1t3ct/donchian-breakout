import { describe, it, expect } from 'vitest';
import { adx, adxSeries } from '../src/indicators/adx.js';
import { makeCandle } from './helpers.js';

function generateTrendCandles(bars: number, start: number, step: number): ReturnType<typeof makeCandle>[] {
  const candles = [];
  let price = start;
  for (let i = 0; i < bars; i++) {
    const open = price;
    price += step;
    const high = Math.max(open, price) + Math.abs(step) * 0.3;
    const low = Math.min(open, price) - Math.abs(step) * 0.1;
    candles.push(makeCandle(i, open, high, low, price));
  }
  return candles;
}

function generateChoppyCandles(bars: number, center: number, amplitude: number): ReturnType<typeof makeCandle>[] {
  const candles = [];
  for (let i = 0; i < bars; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const open = center + dir * amplitude * 0.3;
    const close = center - dir * amplitude * 0.3;
    const high = Math.max(open, close) + amplitude * 0.2;
    const low = Math.min(open, close) - amplitude * 0.2;
    candles.push(makeCandle(i, open, high, low, close));
  }
  return candles;
}

describe('ADX', () => {
  it('returns higher ADX for trending market', () => {
    const trending = generateTrendCandles(40, 100, 1.5);
    const choppy = generateChoppyCandles(40, 100, 2);

    const adxTrend = adx(trending, 14);
    const adxChop = adx(choppy, 14);

    expect(adxTrend).toBeGreaterThan(adxChop);
  });

  it('returns value between 0 and 100', () => {
    const candles = generateTrendCandles(40, 100, 0.5);
    const val = adx(candles, 14);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(100);
  });

  it('throws if insufficient candles', () => {
    const candles = generateTrendCandles(10, 100, 1);
    expect(() => adx(candles, 14)).toThrow();
  });

  describe('adxSeries', () => {
    it('returns nulls during warmup', () => {
      const candles = generateTrendCandles(40, 100, 1);
      const series = adxSeries(candles, 14);
      const minRequired = 2 * 14 + 1;
      for (let i = 0; i < minRequired - 1; i++) {
        expect(series[i]).toBeNull();
      }
      expect(series[minRequired - 1]).not.toBeNull();
    });
  });
});
