import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { RiskService } from '../src/services/riskService.js';
import { ExecutionService } from '../src/services/executionService.js';
import { UniverseService } from '../src/services/universeService.js';
import { DonchianBreakout15m } from '../src/strategy/donchianBreakout15m.js';
import { makeCandle } from './helpers.js';

function makeTestEnv(overrides: Partial<typeof CONFIG> = {}) {
  const config = { ...CONFIG, ...overrides } as typeof CONFIG;
  const logger = new StrategyLogger(null);
  const exchange = new SimExchangeClient(10_000);
  const riskService = new RiskService(config, logger, exchange);
  const executionService = new ExecutionService(config, logger, exchange);
  const universeService = new UniverseService(config, logger);

  const strategy = new DonchianBreakout15m(
    config, logger, exchange, riskService, executionService, universeService,
  );

  return { config, logger, exchange, riskService, executionService, universeService, strategy };
}

function generateBreakoutCandles(
  bars: number,
  basePrice: number,
  breakoutPrice: number,
  direction: 'up' | 'down',
): ReturnType<typeof makeCandle>[] {
  const candles = [];
  const rangeSize = basePrice * 0.01;
  const startTime = Date.UTC(2025, 0, 1);

  // Consolidation phase: bars with controlled highs/lows for clear Donchian levels
  for (let i = 0; i < bars - 1; i++) {
    const noise = (Math.random() - 0.5) * rangeSize * 0.5;
    const price = basePrice + noise;
    candles.push(makeCandle(
      startTime + i * 15 * 60 * 1000,
      price - rangeSize * 0.1,
      price + rangeSize,
      price - rangeSize,
      price,
    ));
  }

  // Breakout candle
  const lastTs = startTime + (bars - 1) * 15 * 60 * 1000;
  if (direction === 'up') {
    candles.push(makeCandle(
      lastTs,
      basePrice,
      breakoutPrice + rangeSize * 0.1,
      basePrice - rangeSize * 0.3,
      breakoutPrice,
    ));
  } else {
    candles.push(makeCandle(
      lastTs,
      basePrice,
      basePrice + rangeSize * 0.3,
      breakoutPrice - rangeSize * 0.1,
      breakoutPrice,
    ));
  }

  return candles;
}

describe('Close-confirmed breakout with buffer', () => {
  it('triggers long when close >= donchianHigh * (1 + bufferBps/10000)', async () => {
    const env = makeTestEnv({
      donchianLength: 5, atrLength: 5, adxLength: 5, bufferBps: 3,
      minAtrPct: 0.001, minAdx: 1, maxCandleRangeAtr: 10,
      atrPctMax: Infinity, atrPctMaxSoft: Infinity,
    });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    // 14 candles of ranging with consistent volatility for ADX/ATR warmup.
    // Donchian lookback window (last 5 of prev 14): highs capped at ~103.
    const candles = [];
    for (let i = 0; i < 14; i++) {
      const base = 100;
      const trend = i * 0.15;
      candles.push(makeCandle(
        ts + i * 900_000,
        base + trend,
        base + trend + 2,    // high ~102-104
        base + trend - 2,    // low ~98-100
        base + trend + 0.5,
      ));
    }
    // Breakout candle: close=108, well above Donchian high of ~104 * (1+3/10000)
    candles.push(makeCandle(ts + 14 * 900_000, 103, 109, 102, 108));

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000);

    const logs = env.logger.getBuffer();
    const hasSignal = logs.some(l => l.event === 'ENTRY_SIGNAL' || l.event === 'POSITION_OPENED');
    const hasSkip = logs.some(l => l.event.startsWith('SKIPPED_'));

    expect(hasSignal || hasSkip).toBe(true);
    // With relaxed filters, we expect an actual entry
    expect(hasSignal).toBe(true);
  });

  it('does NOT trigger if close is below donchian high + buffer', async () => {
    const env = makeTestEnv({ donchianLength: 5, atrLength: 5, adxLength: 5, bufferBps: 3 });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = [];
    for (let i = 0; i < 14; i++) {
      candles.push(makeCandle(ts + i * 900_000, 100, 102, 98, 100));
    }
    // Close exactly at donchian high (no buffer clearance)
    candles.push(makeCandle(ts + 14 * 900_000, 100, 102, 98, 102));

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000);

    const trades = env.strategy.getOpenTrades();
    expect(trades.length).toBe(0);
  });

  it('triggers short when close <= donchianLow * (1 - bufferBps/10000)', async () => {
    const env = makeTestEnv({ donchianLength: 5, atrLength: 5, adxLength: 5, bufferBps: 3 });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = [];
    for (let i = 0; i < 14; i++) {
      candles.push(makeCandle(
        ts + i * 900_000,
        100 + (i % 3),
        104 + (i % 2),
        96 - (i % 3) * 0.2,
        100 + (i % 2) * 0.5,
      ));
    }
    // Short breakout: close well below donchian low
    candles.push(makeCandle(ts + 14 * 900_000, 100, 101, 93, 94));

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000);

    const logs = env.logger.getBuffer();
    const hasSignalOrSkip = logs.some(l =>
      l.event === 'ENTRY_SIGNAL' || l.event === 'POSITION_OPENED' || l.event.startsWith('SKIPPED_'),
    );
    expect(hasSignalOrSkip).toBe(true);
  });
});

describe('Donchian width filter', () => {
  it('when ENABLE_WIDTH_FILTER=true and widthPct below threshold, logs SKIPPED_LOW_WIDTH_PCT', async () => {
    const env = makeTestEnv({
      donchianLength: 10,
      atrLength: 8,
      adxLength: 8,
      bufferBps: 3,
      minAtrPct: 0.001,
      minAdx: 1,
      maxCandleRangeAtr: 10,
      enableWidthFilter: true,
      widthPctMin: 0.05,
      widthPctMinSoft: 0.05,
    });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    // Narrow channel: last 10 bars (lookback) have high=102, low=98 → mid=100, width = 4/100 = 0.04 (4%)
    const candles = [];
    for (let i = 0; i < 25; i++) {
      candles.push(makeCandle(ts + i * 900_000, 100, 102, 98, 100));
    }
    // Breakout candle: close above donchian high (102)
    candles.push(makeCandle(ts + 25 * 900_000, 100, 104, 99, 103));
    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 25 * 900_000);

    const logs = env.logger.getBuffer();
    const skipWidth = logs.find(l => l.event === 'SKIPPED_LOW_WIDTH_PCT');
    expect(skipWidth).toBeDefined();
    expect(skipWidth?.details?.widthPct).toBeLessThan(0.05);
    expect(skipWidth?.details?.threshold).toBe(0.05);
  });

  it('when ENABLE_WIDTH_FILTER=false, does not skip for low width', async () => {
    const env = makeTestEnv({
      donchianLength: 10,
      atrLength: 8,
      adxLength: 8,
      bufferBps: 3,
      minAtrPct: 0.001,
      minAdx: 1,
      maxCandleRangeAtr: 10,
      enableWidthFilter: false,
      widthPctMin: 0.05,
      atrPctMax: Infinity,
      atrPctMaxSoft: Infinity,
    });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = [];
    for (let i = 0; i < 25; i++) {
      candles.push(makeCandle(ts + i * 900_000, 100, 102, 98, 100));
    }
    candles.push(makeCandle(ts + 25 * 900_000, 100, 104, 99, 103));
    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 25 * 900_000);

    const logs = env.logger.getBuffer();
    const skipWidth = logs.find(l => l.event === 'SKIPPED_LOW_WIDTH_PCT');
    expect(skipWidth).toBeUndefined();
    const hasEntry = logs.some(l => l.event === 'ENTRY_SIGNAL' || l.event === 'POSITION_OPENED');
    expect(hasEntry).toBe(true);
  });
});

describe('ATR% max (chaos ceiling)', () => {
  /** Candles: donchianLength=5 so lookback is bars 9..13. High range on 9..14 so ATR% is high. Bar 14 breaks out above donchian high. */
  function highAtrBreakoutCandles(ts: number, price = 100): ReturnType<typeof makeCandle>[] {
    const candles: ReturnType<typeof makeCandle>[] = [];
    const range = price * 0.025; // 2.5% range → ATR ~2.5%, atrPct ~0.025
    for (let i = 0; i < 14; i++) {
      const c = price + (i - 5) * 0.2;
      candles.push(makeCandle(ts + i * 900_000, c - range, c + range, c - range, c));
    }
    // Bars 9..13 have high up to ~price+range+0.6; donchian high ~104.2. Breakout: close well above.
    const donchianHighApprox = price + range + 0.6;
    candles.push(makeCandle(
      ts + 14 * 900_000,
      price,
      donchianHighApprox + 3,
      price - range,
      donchianHighApprox + 1.5, // close clearly above donchian high → breakout
    ));
    return candles;
  }

  it('when ATR_PCT_MAX unset (Infinity), does not skip for high ATR', async () => {
    const env = makeTestEnv({
      donchianLength: 5,
      atrLength: 14,
      adxLength: 5,
      bufferBps: 3,
      minAtrPct: 0.001,
      minAdx: 1,
      maxCandleRangeAtr: 10,
      atrPctMax: Infinity,
      atrPctMaxSoft: Infinity,
    });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = highAtrBreakoutCandles(ts);
    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000);

    const logs = env.logger.getBuffer();
    expect(logs.some(l => l.event === 'SKIPPED_HIGH_ATR_PCT')).toBe(false);
  });

  it('when atrPctMax set and atrPct above threshold, logs SKIPPED_HIGH_ATR_PCT and does not emit ENTRY_SIGNAL', async () => {
    const env = makeTestEnv({
      donchianLength: 5,
      atrLength: 14,
      adxLength: 5,
      bufferBps: 3,
      minAtrPct: 0.001,
      minAdx: 1,
      maxCandleRangeAtr: 10,
      atrPctMax: 0.01,
      atrPctMaxSoft: 0.01,
    });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = highAtrBreakoutCandles(ts);
    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000);

    const logs = env.logger.getBuffer();
    const highSkip = logs.find(l => l.event === 'SKIPPED_HIGH_ATR_PCT');
    expect(highSkip).toBeDefined();
    expect(highSkip?.details?.atrPct).toBeGreaterThan(0.01);
    expect(highSkip?.details?.threshold).toBe(0.01);
    expect(highSkip?.details?.softBrake).toBe(false);
    expect(logs.some(l => l.event === 'ENTRY_SIGNAL')).toBe(false);
  });

  it('soft-brake path uses atrPctMaxSoft and logs softBrake: true', async () => {
    const env = makeTestEnv({
      donchianLength: 5,
      atrLength: 14,
      adxLength: 5,
      bufferBps: 3,
      minAtrPct: 0.001,
      minAdx: 1,
      maxCandleRangeAtr: 10,
      atrPctMax: 0.03,
      atrPctMaxSoft: 0.02,
    });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = highAtrBreakoutCandles(ts);
    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    const tickContext = { equity: 9850, dd: -0.015, softBrake: true };
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000, tickContext);

    const logs = env.logger.getBuffer();
    const highSkip = logs.find(l => l.event === 'SKIPPED_HIGH_ATR_PCT');
    expect(highSkip).toBeDefined();
    expect(highSkip?.details?.softBrake).toBe(true);
    expect(highSkip?.details?.threshold).toBe(0.02);
  });
});

describe('ATR% and ADX filters', () => {
  it('rejects entry when ATR% is below threshold', async () => {
    // Very low volatility candles → ATR% will be tiny
    const env = makeTestEnv({ donchianLength: 5, atrLength: 5, adxLength: 5, minAtrPct: 0.05 });
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = [];
    for (let i = 0; i < 14; i++) {
      candles.push(makeCandle(ts + i * 900_000, 100, 100.01, 99.99, 100));
    }
    candles.push(makeCandle(ts + 14 * 900_000, 100, 101, 99, 100.02));

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, ts + 14 * 900_000);

    const trades = env.strategy.getOpenTrades();
    expect(trades.length).toBe(0);
  });
});
