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

const INTERVAL = 15 * 60 * 1000;

function buildCandlesWithBreakout(opts: {
  bars: number;
  basePrice: number;
  breakoutClose: number;
  direction: 'up' | 'down';
  startTime: number;
}) {
  const candles = [];
  const range = opts.basePrice * 0.015;

  for (let i = 0; i < opts.bars - 1; i++) {
    const noise = ((i * 7) % 5 - 2) * range * 0.05;
    const close = opts.basePrice + noise;
    candles.push(makeCandle(
      opts.startTime + i * INTERVAL,
      close - range * 0.1,
      close + range,
      close - range,
      close,
    ));
  }

  const ts = opts.startTime + (opts.bars - 1) * INTERVAL;
  if (opts.direction === 'up') {
    candles.push(makeCandle(ts, opts.basePrice, opts.breakoutClose + range * 0.1, opts.basePrice - range * 0.3, opts.breakoutClose));
  } else {
    candles.push(makeCandle(ts, opts.basePrice, opts.basePrice + range * 0.3, opts.breakoutClose - range * 0.1, opts.breakoutClose));
  }
  return candles;
}

describe('Cooldown after stop-out', () => {
  const relaxedFilters = {
    donchianLength: 5,
    atrLength: 5,
    adxLength: 5,
    bufferBps: 3,
    minAtrPct: 0.001,
    minAdx: 1,
    maxCandleRangeAtr: 10,
    cooldownBars: 5,
    stopAtrMult: 2.0,
    trailAtrMult: 3.0,
    atrPctMax: Infinity,
    atrPctMaxSoft: Infinity,
  };

  it('blocks re-entry in same symbol+direction within cooldown window', async () => {
    const env = makeTestEnv(relaxedFilters);
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = buildCandlesWithBreakout({
      bars: 15,
      basePrice: 100,
      breakoutClose: 108,
      direction: 'up',
      startTime: ts,
    });

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, candles[candles.length - 1].timestamp);

    const openedTrade = env.strategy.getOpenTradeForSymbol('TEST');
    expect(openedTrade).toBeDefined();
    expect(openedTrade!.side).toBe('long');

    const stopCandle = makeCandle(
      candles[candles.length - 1].timestamp + INTERVAL,
      108,
      108.5,
      openedTrade!.initialStop - 1,
      openedTrade!.initialStop - 0.5,
    );
    candles.push(stopCandle);
    env.exchange.setCurrentCandle('TEST', stopCandle);
    await env.strategy.onBar('TEST', candles, stopCandle.timestamp);

    expect(env.strategy.getOpenTradeForSymbol('TEST')).toBeUndefined();

    const stoppedBar = env.strategy.getBarIndex();

    for (let i = 0; i < 3; i++) {
      const barTs = stopCandle.timestamp + (i + 1) * INTERVAL;
      const reBreakCandle = makeCandle(barTs, 100, 112, 99, 110);
      candles.push(reBreakCandle);
      env.exchange.setCurrentCandle('TEST', reBreakCandle);
      await env.strategy.onBar('TEST', candles, barTs);
    }

    const logs = env.logger.getBuffer();
    const cooldownSkips = logs.filter(l => l.event === 'SKIPPED_COOLDOWN');
    expect(cooldownSkips.length).toBeGreaterThan(0);

    expect(env.strategy.getOpenTradeForSymbol('TEST')).toBeUndefined();
  });

  it('allows entry in opposite direction during cooldown', async () => {
    const env = makeTestEnv(relaxedFilters);
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = buildCandlesWithBreakout({
      bars: 15,
      basePrice: 100,
      breakoutClose: 108,
      direction: 'up',
      startTime: ts,
    });

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, candles[candles.length - 1].timestamp);

    const openedTrade = env.strategy.getOpenTradeForSymbol('TEST');
    expect(openedTrade).toBeDefined();

    const stopCandle = makeCandle(
      candles[candles.length - 1].timestamp + INTERVAL,
      108,
      108.5,
      openedTrade!.initialStop - 1,
      openedTrade!.initialStop - 0.5,
    );
    candles.push(stopCandle);
    env.exchange.setCurrentCandle('TEST', stopCandle);
    await env.strategy.onBar('TEST', candles, stopCandle.timestamp);

    expect(env.strategy.getOpenTradeForSymbol('TEST')).toBeUndefined();

    const shortBreakCandle = makeCandle(
      stopCandle.timestamp + INTERVAL,
      95,
      96,
      87,
      88,
    );
    candles.push(shortBreakCandle);
    env.exchange.setCurrentCandle('TEST', shortBreakCandle);
    await env.strategy.onBar('TEST', candles, shortBreakCandle.timestamp);

    const logs = env.logger.getBuffer();
    const cooldownSkips = logs.filter(l => l.event === 'SKIPPED_COOLDOWN');
    const shortSignals = logs.filter(l => l.side === 'short' && (l.event === 'ENTRY_SIGNAL' || l.event === 'POSITION_OPENED'));

    const wasBlockedByOtherFilter = cooldownSkips.some(l => l.side === 'short');
    expect(wasBlockedByOtherFilter).toBe(false);
  });

  it('allows re-entry after cooldown expires (5 bars)', async () => {
    const env = makeTestEnv(relaxedFilters);
    const ts = Date.UTC(2025, 0, 1);
    await env.riskService.initDay(ts, 10_000);

    const candles = buildCandlesWithBreakout({
      bars: 15,
      basePrice: 100,
      breakoutClose: 108,
      direction: 'up',
      startTime: ts,
    });

    env.exchange.setCurrentCandle('TEST', candles[candles.length - 1]);
    await env.strategy.onBar('TEST', candles, candles[candles.length - 1].timestamp);

    const openedTrade = env.strategy.getOpenTradeForSymbol('TEST');
    expect(openedTrade).toBeDefined();

    const stopCandle = makeCandle(
      candles[candles.length - 1].timestamp + INTERVAL,
      108,
      108.5,
      openedTrade!.initialStop - 1,
      openedTrade!.initialStop - 0.5,
    );
    candles.push(stopCandle);
    env.exchange.setCurrentCandle('TEST', stopCandle);
    await env.strategy.onBar('TEST', candles, stopCandle.timestamp);

    expect(env.strategy.getOpenTradeForSymbol('TEST')).toBeUndefined();

    for (let i = 0; i < 6; i++) {
      const barTs = stopCandle.timestamp + (i + 1) * INTERVAL;
      const neutralCandle = makeCandle(barTs, 100, 103, 97, 100);
      candles.push(neutralCandle);
      env.exchange.setCurrentCandle('TEST', neutralCandle);
      await env.strategy.onBar('TEST', candles, barTs);
    }

    env.logger.clearBuffer();

    const breakoutTs = stopCandle.timestamp + 7 * INTERVAL;
    const breakoutCandle = makeCandle(breakoutTs, 100, 112, 99, 110);
    candles.push(breakoutCandle);
    env.exchange.setCurrentCandle('TEST', breakoutCandle);
    await env.strategy.onBar('TEST', candles, breakoutTs);

    const logs = env.logger.getBuffer();
    const cooldownSkip = logs.find(l => l.event === 'SKIPPED_COOLDOWN');
    expect(cooldownSkip).toBeUndefined();
  });
});
