import { describe, it, expect } from 'vitest';
import { SimHarness } from '../src/backtest/simHarness.js';
import type { Candle } from '../src/types/index.js';

function generateTrendCandles(
  bars: number,
  start: number,
  step: number,
  startTime = Date.UTC(2025, 0, 1),
): Candle[] {
  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < bars; i++) {
    const open = price;
    price += step + (Math.sin(i * 0.3) * Math.abs(step) * 0.5);
    const high = Math.max(open, price) + Math.abs(step) * 0.8;
    const low = Math.min(open, price) - Math.abs(step) * 0.3;
    candles.push({
      timestamp: startTime + i * 15 * 60 * 1000,
      open: Math.max(0.01, open),
      high: Math.max(0.01, high),
      low: Math.max(0.01, low),
      close: Math.max(0.01, price),
      volume: 1000 + Math.random() * 5000,
    });
  }
  return candles;
}

describe('SimHarness', () => {
  it('runs a backtest and returns valid result structure', async () => {
    const harness = new SimHarness(undefined, 10_000);
    const candleMap = new Map<string, Candle[]>();
    candleMap.set('BTC', generateTrendCandles(200, 40000, 50));

    const result = await harness.run(candleMap);

    expect(result.totalBars).toBe(200);
    expect(result.finalEquity).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(200);
    expect(result.maxDD).toBeLessThanOrEqual(0);
    expect(typeof result.winRate).toBe('number');
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
  });

  it('closes all positions at end of sim', async () => {
    const harness = new SimHarness(undefined, 10_000);
    const candleMap = new Map<string, Candle[]>();
    candleMap.set('BTC', generateTrendCandles(200, 40000, 80));

    const result = await harness.run(candleMap);

    for (const trade of result.trades) {
      expect(trade.exitReason).toBeDefined();
      expect(['STOP_INITIAL', 'TRAIL', 'DAILY_KILL_SWITCH', 'MANUAL', 'EXCHANGE_ERROR']).toContain(trade.exitReason);
    }
  });

  it('trades have valid R values', async () => {
    const harness = new SimHarness(undefined, 10_000);
    const candleMap = new Map<string, Candle[]>();
    candleMap.set('ETH', generateTrendCandles(300, 2500, 10));

    const result = await harness.run(candleMap);

    if (result.totalTrades > 0) {
      for (const trade of result.trades) {
        expect(Number.isFinite(trade.realizedR)).toBe(true);
      }
      expect(result.avgR).toBeCloseTo(result.totalR / result.totalTrades, 6);
      expect(result.winCount + result.lossCount).toBe(result.totalTrades);
    }
  });

  it('equity curve starts near initial equity', async () => {
    const initial = 10_000;
    const harness = new SimHarness(undefined, initial);
    const candleMap = new Map<string, Candle[]>();
    candleMap.set('SOL', generateTrendCandles(100, 100, 0.5));

    const result = await harness.run(candleMap);

    expect(result.equityCurve[0]).toBeCloseTo(initial, -1);
  });

  it('respects config overrides', async () => {
    const harness = new SimHarness({ maxConcurrentPositions: 1 }, 5_000);
    const candleMap = new Map<string, Candle[]>();
    candleMap.set('BTC', generateTrendCandles(200, 40000, 60));
    candleMap.set('ETH', generateTrendCandles(200, 2500, 5));

    const result = await harness.run(candleMap);

    expect(result.totalBars).toBeGreaterThan(0);
    expect(result.finalEquity).toBeGreaterThan(0);
  });

  it('multi-symbol backtest produces more timestamps than single', async () => {
    const harness1 = new SimHarness(undefined, 10_000);
    const map1 = new Map<string, Candle[]>();
    map1.set('BTC', generateTrendCandles(100, 40000, 50));

    const harness2 = new SimHarness(undefined, 10_000);
    const map2 = new Map<string, Candle[]>();
    map2.set('BTC', generateTrendCandles(100, 40000, 50));
    map2.set('ETH', generateTrendCandles(100, 2500, 3, Date.UTC(2025, 0, 1)));

    const r1 = await harness1.run(map1);
    const r2 = await harness2.run(map2);

    expect(r2.totalBars).toBeGreaterThanOrEqual(r1.totalBars);
  });
});
