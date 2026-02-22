import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { ExecutionService } from '../src/services/executionService.js';
import { makeCandle } from './helpers.js';

function makeExecEnv(overrides: Partial<typeof CONFIG> = {}) {
  const config = { ...CONFIG, ...overrides } as typeof CONFIG;
  const logger = new StrategyLogger(null);
  const exchange = new SimExchangeClient(10_000, 2, 0.00035);
  const execution = new ExecutionService(config, logger, exchange);
  return { config, logger, exchange, execution };
}

describe('ExecutionService', () => {
  describe('checkMicrostructure', () => {
    it('passes when spread and volatility are within limits', async () => {
      const env = makeExecEnv();
      const candle = makeCandle(Date.now(), 100, 101, 99, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const feedCandles = [];
      for (let i = 0; i < 5; i++) {
        feedCandles.push(makeCandle(Date.now() - (5 - i) * 60_000, 100, 100.5, 99.5, 100));
      }
      env.exchange.feedCandles('TEST', feedCandles);

      const result = await env.execution.checkMicrostructure('TEST');
      expect(result.pass).toBe(true);
      expect(result.spreadBps).toBeLessThanOrEqual(10);
    });

    it('fails when spread exceeds maxSpreadBps', async () => {
      const env = makeExecEnv({ maxSpreadBps: 1 });
      const candle = makeCandle(Date.now(), 100, 101, 99, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const result = await env.execution.checkMicrostructure('TEST');
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('spread');
    });
  });

  describe('executeEntry', () => {
    it('fills via maker path when conditions are met', async () => {
      const env = makeExecEnv();
      const candle = makeCandle(Date.now(), 100, 101, 99, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const feedCandles = [];
      for (let i = 0; i < 5; i++) {
        feedCandles.push(makeCandle(Date.now() - (5 - i) * 60_000, 100, 100.5, 99.5, 100));
      }
      env.exchange.feedCandles('TEST', feedCandles);

      const result = await env.execution.executeEntry('TEST', 'long', 0.1, 100);
      expect(result.fill.filled).toBe(true);
      expect(result.path).toBe('MAKER_FILLED');
      expect(result.fill.fillPrice).toBeDefined();
    });

    it('blocks entry when microstructure fails', async () => {
      const env = makeExecEnv({ maxSpreadBps: 1 });
      const candle = makeCandle(Date.now(), 100, 101, 99, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const result = await env.execution.executeEntry('TEST', 'long', 0.1, 100);
      expect(result.fill.filled).toBe(false);
      expect(result.path).toBe('SKIPPED_BAD_MICROSTRUCTURE');

      const logs = env.logger.getBuffer();
      expect(logs.some(l => l.executionPath === 'SKIPPED_BAD_MICROSTRUCTURE')).toBe(true);
    });
  });

  describe('executeEntrySim', () => {
    it('fills immediately via simulated market order', async () => {
      const env = makeExecEnv();
      const candle = makeCandle(Date.now(), 100, 101, 99, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const result = await env.execution.executeEntrySim('TEST', 'short', 0.5, 100);
      expect(result.fill.filled).toBe(true);
      expect(result.path).toBe('MAKER_FILLED');
      expect(result.fill.fillSize).toBe(0.5);
    });

    it('charges slippage and fees on sim fill', async () => {
      const env = makeExecEnv();
      const candle = makeCandle(Date.now(), 100, 101, 99, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const result = await env.execution.executeEntrySim('TEST', 'long', 1, 100);
      expect(result.fill.filled).toBe(true);
      expect(result.fill.fees).toBeGreaterThan(0);
      expect(result.fill.slippageBps).toBeGreaterThan(0);
    });
  });
});
