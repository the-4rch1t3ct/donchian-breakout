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
      const env = makeExecEnv({ makerTimeoutMs: 5 });
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

      const logs = env.logger.getBuffer();
      const orderPlaced = logs.filter(l => l.module === 'EXCHANGE' && l.event === 'ORDER_PLACED');
      const orderFilled = logs.filter(l => l.module === 'EXCHANGE' && l.event === 'ORDER_FILLED');
      expect(orderPlaced.length).toBeGreaterThanOrEqual(1);
      expect(orderFilled.length).toBe(1);
      expect((orderPlaced[0].details as Record<string, unknown>)?.orderType).toBe('LIMIT_MAKER');
      expect((orderPlaced[0].details as Record<string, unknown>)?.attempt).toBe(1);
    });

    it('when maker does not fill within timeout, cancels and places IOC then fills', async () => {
      const env = makeExecEnv({ makerTimeoutMs: 5, iocMaxSlippageBps: 8 });
      // Candle with low=100 so Sim maker (bestBid*1.0001 ~99.98) does not cross: no fill
      const candle = makeCandle(Date.now(), 100, 101, 100, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const feedCandles = [];
      for (let i = 0; i < 5; i++) {
        feedCandles.push(makeCandle(Date.now() - (5 - i) * 60_000, 100, 100.5, 99.5, 100));
      }
      env.exchange.feedCandles('TEST', feedCandles);

      const result = await env.execution.executeEntry('TEST', 'long', 0.1, 100);
      expect(result.fill.filled).toBe(true);
      expect(result.path).toBe('MAKER_TIMEOUT_TAKER');

      const logs = env.logger.getBuffer();
      const events = logs.filter(l => l.module === 'EXCHANGE').map(l => l.event);
      expect(events).toContain('ORDER_PLACED');
      expect(events).toContain('ORDER_CANCELLED');
      expect(events).toContain('ORDER_FILLED');
      const orderPlacedLogs = logs.filter(l => l.module === 'EXCHANGE' && l.event === 'ORDER_PLACED');
      expect(orderPlacedLogs.length).toBe(2); // maker then IOC
      const cancelled = logs.find(l => l.module === 'EXCHANGE' && l.event === 'ORDER_CANCELLED');
      expect(cancelled).toBeDefined();
      expect((cancelled!.details as Record<string, unknown>)?.reason).toBe('CANCEL_TIMEOUT');
    });

    it('when IOC would run but microstructure recheck fails, skips without placing IOC', async () => {
      const env = makeExecEnv({ makerTimeoutMs: 5 });
      const candle = makeCandle(Date.now(), 100, 101, 100, 100);
      env.exchange.setCurrentCandle('TEST', candle);

      const feedCandles = [];
      for (let i = 0; i < 5; i++) {
        feedCandles.push(makeCandle(Date.now() - (5 - i) * 60_000, 100, 100.5, 99.5, 100));
      }
      env.exchange.feedCandles('TEST', feedCandles);

      let getOrderBookTopCallCount = 0;
      const origGetOrderBookTop = env.exchange.getOrderBookTop.bind(env.exchange);
      env.exchange.getOrderBookTop = async (sym: string) => {
        getOrderBookTopCallCount++;
        const book = await origGetOrderBookTop(sym);
        if (getOrderBookTopCallCount >= 2) {
          return { ...book, spreadBps: 999, bestBid: book.bestBid, bestAsk: book.bestAsk, bidSize: book.bidSize, askSize: book.askSize, timestamp: book.timestamp };
        }
        return book;
      };

      const result = await env.execution.executeEntry('TEST', 'long', 0.1, 100);
      expect(result.fill.filled).toBe(false);
      expect(result.path).toBe('SKIPPED_BAD_MICROSTRUCTURE');

      const logs = env.logger.getBuffer();
      const orderPlacedLogs = logs.filter(l => l.module === 'EXCHANGE' && l.event === 'ORDER_PLACED');
      expect(orderPlacedLogs.length).toBe(1); // only maker, no IOC
      expect(logs.some(l => l.event === 'TAKER_BLOCKED_MICROSTRUCTURE')).toBe(true);
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
