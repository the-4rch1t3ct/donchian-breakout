import { describe, it, expect } from 'vitest';
import { donchian, donchianSeries } from '../src/indicators/donchian.js';
import { makeCandle } from './helpers.js';

function makePriceCandles(highs: number[], lows: number[]): ReturnType<typeof makeCandle>[] {
  return highs.map((h, i) => makeCandle(i, lows[i], h, lows[i], (h + lows[i]) / 2));
}

describe('Donchian Channel', () => {
  it('computes highest high and lowest low over N periods', () => {
    const candles = makePriceCandles(
      [10, 12, 11, 15, 13, 14, 16, 12, 11, 10],
      [8,  9,  7,  10, 9,  11, 12, 8,  7,  6],
    );
    const result = donchian(candles, 5);
    // last 5 candles: highs=[14,16,12,11,10], lows=[11,12,8,7,6]
    expect(result.high).toBe(16);
    expect(result.low).toBe(6);
    expect(result.mid).toBe((16 + 6) / 2);
  });

  it('throws if insufficient candles', () => {
    const candles = makePriceCandles([10, 12], [8, 9]);
    expect(() => donchian(candles, 5)).toThrow('Need at least 5 candles');
  });

  it('handles length=1 (just the last candle)', () => {
    const candles = makePriceCandles([10, 15, 12], [8, 11, 9]);
    const result = donchian(candles, 1);
    expect(result.high).toBe(12);
    expect(result.low).toBe(9);
  });

  it('handles all same prices', () => {
    const candles = makePriceCandles([100, 100, 100], [100, 100, 100]);
    const result = donchian(candles, 3);
    expect(result.high).toBe(100);
    expect(result.low).toBe(100);
  });

  describe('donchianSeries', () => {
    it('returns null for insufficient warmup, then values', () => {
      const candles = makePriceCandles(
        [10, 12, 15, 11, 14],
        [8,  9,  10, 7,  11],
      );
      const series = donchianSeries(candles, 3);
      expect(series[0]).toBeNull();
      expect(series[1]).toBeNull();
      expect(series[2]).not.toBeNull();
      expect(series[2]!.high).toBe(15);
      expect(series[2]!.low).toBe(8);
    });
  });
});
