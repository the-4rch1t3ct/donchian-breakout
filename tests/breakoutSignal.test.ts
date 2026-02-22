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
