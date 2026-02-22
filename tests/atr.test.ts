import { describe, it, expect } from 'vitest';
import { atr, trueRange, atrSeries } from '../src/indicators/atr.js';
import { makeCandle } from './helpers.js';

describe('trueRange', () => {
  it('returns high-low when it dominates', () => {
    const candle = makeCandle(0, 100, 110, 90, 105);
    expect(trueRange(candle, 100)).toBe(20); // high-low = 20
  });

  it('accounts for gap up', () => {
    const candle = makeCandle(0, 110, 115, 108, 112);
    expect(trueRange(candle, 100)).toBe(15); // |115-100| = 15
  });

  it('accounts for gap down', () => {
    const candle = makeCandle(0, 90, 92, 88, 89);
    expect(trueRange(candle, 100)).toBe(12); // |88-100| = 12
  });
});

describe('ATR', () => {
  it('computes ATR using Wilder smoothing', () => {
    // 16 candles: enough for ATR(14) which needs length+1 = 15
    const candles = [];
    let price = 100;
    for (let i = 0; i < 16; i++) {
      const change = (i % 3 === 0) ? 2 : -1;
      const open = price;
      price += change;
      candles.push(makeCandle(i, open, Math.max(open, price) + 1, Math.min(open, price) - 0.5, price));
    }
    const result = atr(candles, 14);
    expect(result).toBeGreaterThan(0);
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });

  it('throws if insufficient candles', () => {
    const candles = [makeCandle(0, 100, 102, 98, 101), makeCandle(1, 101, 103, 99, 102)];
    expect(() => atr(candles, 14)).toThrow();
  });

  it('atrSeries returns nulls for warmup period', () => {
    const candles = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      const open = price;
      price += (Math.random() - 0.5) * 4;
      candles.push(makeCandle(i, open, Math.max(open, price) + 1, Math.min(open, price) - 0.5, price));
    }
    const series = atrSeries(candles, 14);
    for (let i = 0; i < 14; i++) {
      expect(series[i]).toBeNull();
    }
    for (let i = 14; i < 20; i++) {
      expect(series[i]).not.toBeNull();
      expect(series[i]!).toBeGreaterThan(0);
    }
  });
});
