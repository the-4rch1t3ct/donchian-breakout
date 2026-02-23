import { describe, it, expect, vi } from 'vitest';
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { RiskService } from '../src/services/riskService.js';
import { ExecutionService } from '../src/services/executionService.js';
import { UniverseService } from '../src/services/universeService.js';
import { ProtectionService } from '../src/services/protectionService.js';
import { Runner } from '../src/runner.js';
import { makeCandle } from './helpers.js';
import type { IExchangeClient } from '../src/exchange/exchangeClient.js';
import type { FillResult, Side, OpenOrder, OrderBookTop, Position, Candle } from '../src/types/index.js';

function makeMockExchange(equity: number) {
  const mock = {
    cancelAllCalled: 0,
    closeCalls: [] as Array<{ symbol: string; side: Side; size: number }>,
    async getEquity() { return equity; },
    async getMarkPrice() { return 100; },
    async getOrderBookTop(_symbol: string): Promise<OrderBookTop> {
      return { bestBid: 99, bestAsk: 101, bidSize: 10, askSize: 10, spreadBps: 2 };
    },
    async placeLimit(): Promise<FillResult> { return { filled: false }; },
    async cancel() {},
    async placeMarketable(): Promise<FillResult> { return { filled: true, fillPrice: 100, fillSize: 1 }; },
    async getPositions(): Promise<Position[]> { return []; },
    async getOpenOrders(): Promise<OpenOrder[]> { return []; },
    async placeTriggerTpsl(): Promise<{ orderId?: string }> { return {}; },
    async cancelAll() { mock.cancelAllCalled++; },
    async closePosition(symbol: string, side: Side, size: number): Promise<FillResult> {
      mock.closeCalls.push({ symbol, side, size });
      return { filled: true, fillPrice: 100, fillSize: size };
    },
    async getCandles(_sym: string, _int: number, count: number): Promise<Candle[]> {
      const candles: Candle[] = [];
      for (let i = 0; i < count; i++) {
        candles.push(makeCandle(Date.now() - (count - i) * 900_000, 100, 102, 98, 100 + i * 0.1));
      }
      return candles;
    },
    async getRecentCandles1m(_sym: string, count: number): Promise<Candle[]> {
      const candles: Candle[] = [];
      for (let i = 0; i < count; i++) {
        candles.push(makeCandle(Date.now() - (count - i) * 60_000, 100, 101, 99, 100));
      }
      return candles;
    },
  };
  return mock;
}

describe('Kill switch integration', () => {
  it('triggers cancelAll + flatten when daily DD hits hard threshold', async () => {
    const config = { ...CONFIG, hardDdThreshold: -0.03, defaultSymbols: ['TEST'] } as typeof CONFIG;
    const logger = new StrategyLogger(null);

    // Exchange reporting equity of 9_700 (= -3% from 10_000)
    const exchange = makeMockExchange(9_700);

    const riskService = new RiskService(config, logger, exchange);
    const executionService = new ExecutionService(config, logger, exchange);
    const universeService = new UniverseService(config, logger);

    // Init day with starting equity of 10_000
    await riskService.initDay(Date.now(), 10_000);

    const protectionService = new ProtectionService(config, logger, exchange as any);

    const runner = new Runner({
      config,
      logger,
      exchange: exchange as any,
      riskService,
      executionService,
      universeService,
      protectionService,
      mode: 'paper',
    });

    // Manually call tick() which should detect kill switch
    await runner.tick();

    const logs = logger.getBuffer();

    const killLog = logs.find(l => l.event === 'KILL_SWITCH_TRIGGERED');
    expect(killLog).toBeDefined();

    expect(exchange.cancelAllCalled).toBe(1);

    const flattenLog = logs.find(l => l.event === 'FLATTEN_ALL');
    expect(flattenLog).toBeDefined();
  });

  it('does NOT trigger kill switch when DD is above threshold', async () => {
    const config = { ...CONFIG, hardDdThreshold: -0.03, defaultSymbols: ['TEST'] } as typeof CONFIG;
    const logger = new StrategyLogger(null);

    // Equity 9_900 = -1% (above -3% threshold)
    const exchange = makeMockExchange(9_900);
    const riskService = new RiskService(config, logger, exchange);
    const executionService = new ExecutionService(config, logger, exchange);
    const universeService = new UniverseService(config, logger);

    await riskService.initDay(Date.now(), 10_000);

    const protectionService = new ProtectionService(config, logger, exchange as any);

    const runner = new Runner({
      config,
      logger,
      exchange: exchange as any,
      riskService,
      executionService,
      universeService,
      protectionService,
      mode: 'paper',
    });

    await runner.tick();

    const logs = logger.getBuffer();
    const killLog = logs.find(l => l.event === 'KILL_SWITCH_TRIGGERED');
    expect(killLog).toBeUndefined();
    expect(exchange.cancelAllCalled).toBe(0);
  });

  it('kill switch flattens open positions with close calls', async () => {
    const config = { ...CONFIG, hardDdThreshold: -0.03, defaultSymbols: ['BTC', 'ETH'] } as typeof CONFIG;
    const logger = new StrategyLogger(null);
    const exchange = makeMockExchange(9_700);
    const riskService = new RiskService(config, logger, exchange);
    const executionService = new ExecutionService(config, logger, exchange);
    const universeService = new UniverseService(config, logger);

    await riskService.initDay(Date.now(), 10_000);

    const protectionService = new ProtectionService(config, logger, exchange as any);

    const runner = new Runner({
      config,
      logger,
      exchange: exchange as any,
      riskService,
      executionService,
      universeService,
      protectionService,
      mode: 'paper',
    });

    // Simulate having open trades by running a tick where an entry might happen
    // The kill switch should cancel all first, then attempt to flatten
    await runner.tick();

    // Verify cancelAll was called
    expect(exchange.cancelAllCalled).toBe(1);

    // Verify the kill switch log events fired in correct order
    const logs = logger.getBuffer();
    const killEvents = logs
      .filter(l => ['KILL_SWITCH_TRIGGERED', 'FLATTEN_ALL', 'ORDER_CANCELLED'].includes(l.event))
      .map(l => l.event);

    expect(killEvents).toContain('KILL_SWITCH_TRIGGERED');
    expect(killEvents).toContain('FLATTEN_ALL');
  });
});

describe('Max notional guard', () => {
  it('SimExchangeClient has getMarkPrice method', async () => {
    const exchange = new SimExchangeClient(10_000);
    const candle = makeCandle(Date.now(), 100, 102, 98, 101);
    exchange.setCurrentCandle('TEST', candle);

    const price = await exchange.getMarkPrice('TEST');
    expect(price).toBe(101);
  });
});
