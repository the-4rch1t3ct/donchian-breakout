import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { RiskService } from '../src/services/riskService.js';
import { ExecutionService } from '../src/services/executionService.js';
import { UniverseService } from '../src/services/universeService.js';
import { Runner, createExchangeClient } from '../src/runner.js';
import { makeCandle } from './helpers.js';
import type { IExchangeClient } from '../src/exchange/exchangeClient.js';

function makeTestConfig(overrides: Partial<typeof CONFIG> = {}) {
  return { ...CONFIG, ...overrides } as typeof CONFIG;
}

function makeSimDeps(overrides: Partial<typeof CONFIG> = {}) {
  const config = makeTestConfig(overrides);
  const logger = new StrategyLogger(null);
  const exchange = new SimExchangeClient(10_000);
  const riskService = new RiskService(config, logger, exchange);
  const executionService = new ExecutionService(config, logger, exchange);
  const universeService = new UniverseService(config, logger);
  return { config, logger, exchange, riskService, executionService, universeService };
}

describe('createExchangeClient', () => {
  it('returns SimExchangeClient for mode=sim', async () => {
    const logger = new StrategyLogger(null);
    const config = makeTestConfig();
    const client = await createExchangeClient('sim', config, logger);
    expect(client).toBeDefined();
    expect(typeof client.getEquity).toBe('function');
    expect(typeof client.getOrderBookTop).toBe('function');
  });

  it('throws for mode=live without credentials', async () => {
    const logger = new StrategyLogger(null);
    const config = makeTestConfig({ hlWalletAddress: '', hlPrivateKey: '' });
    await expect(createExchangeClient('live', config, logger))
      .rejects.toThrow('HL_WALLET_ADDRESS');
  });

  it('throws for unknown mode', async () => {
    const logger = new StrategyLogger(null);
    const config = makeTestConfig();
    await expect(createExchangeClient('unknown' as any, config, logger))
      .rejects.toThrow('Unknown mode');
  });
});

describe('Runner live safety gate', () => {
  it('refuses to start in live mode without LIVE_TRADING=true', () => {
    const deps = makeSimDeps();
    const origEnv = process.env.LIVE_TRADING;
    delete process.env.LIVE_TRADING;

    const runner = new Runner({
      ...deps,
      mode: 'live',
    });

    expect(() => runner.start()).rejects.toThrow('LIVE_TRADING=true');
    process.env.LIVE_TRADING = origEnv;
  });

  it('proceeds in paper mode without LIVE_TRADING env', async () => {
    const deps = makeSimDeps();
    const origEnv = process.env.LIVE_TRADING;
    delete process.env.LIVE_TRADING;

    // Feed a candle to the exchange so getOrderBookTop works
    const candle = makeCandle(Date.now(), 100, 101, 99, 100);
    for (const sym of deps.config.defaultSymbols) {
      deps.exchange.setCurrentCandle(sym, candle);
      deps.exchange.feedCandles(sym, [candle]);
    }

    const runner = new Runner({ ...deps, mode: 'paper' });

    // startupChecks should succeed without LIVE_TRADING gate
    await runner.startupChecks();

    const logs = deps.logger.getBuffer();
    const startupLogs = logs.filter(l => l.event === 'LIVE_STARTUP_CHECK');
    expect(startupLogs.length).toBeGreaterThan(0);

    process.env.LIVE_TRADING = origEnv;
  });
});

describe('Runner startup checks', () => {
  it('logs config snapshot and verifies connectivity', async () => {
    const deps = makeSimDeps();
    const candle = makeCandle(Date.now(), 100, 101, 99, 100);
    for (const sym of deps.config.defaultSymbols) {
      deps.exchange.setCurrentCandle(sym, candle);
      deps.exchange.feedCandles(sym, [candle]);
    }

    const runner = new Runner({ ...deps, mode: 'paper' });
    await runner.startupChecks();

    const logs = deps.logger.getBuffer();

    const startupLogs = logs.filter(l => l.event === 'LIVE_STARTUP_CHECK');
    expect(startupLogs.length).toBe(1);

    const d = startupLogs[0]!.details as any;
    expect(d.mode).toBe('paper');
    expect(d.equity).toBe(10_000);
    expect(d.positionCount).toBeDefined();
    expect(d.connectivity).toBeDefined();
    expect(Object.keys(d.connectivity).length).toBe(d.symbols?.length ?? 10);
  });
});
