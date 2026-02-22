import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { RiskService } from '../src/services/riskService.js';
import { ExecutionService } from '../src/services/executionService.js';
import { UniverseService } from '../src/services/universeService.js';
import { DonchianBreakout15m } from '../src/strategy/donchianBreakout15m.js';
import { makeCandle } from './helpers.js';
import type { TradeState } from '../src/types/index.js';

describe('Trailing stop monotonic behavior', () => {
  it('long trailing stop only moves UP, never down', () => {
    const config = { ...CONFIG } as typeof CONFIG;
    const logger = new StrategyLogger(null);
    const exchange = new SimExchangeClient(10_000);
    const riskService = new RiskService(config, logger, exchange);
    const executionService = new ExecutionService(config, logger, exchange);
    const universeService = new UniverseService(config, logger);
    const strategy = new DonchianBreakout15m(
      config, logger, exchange, riskService, executionService, universeService,
    );

    const trade: TradeState = {
      symbol: 'TEST',
      side: 'long',
      entryPrice: 100,
      entryTime: 0,
      size: 1,
      leverage: 5,
      initialStop: 96,
      trailingStop: 94,
      atrAtEntry: 2,
      riskAmount: 25,
      executionPath: 'MAKER_FILLED',
    };

    const atrVal = 2;
    const stops: number[] = [trade.trailingStop];

    // Price goes up → trail should rise
    strategy.updateTrailingStop(trade, makeCandle(1, 100, 106, 99, 105), atrVal);
    stops.push(trade.trailingStop);

    strategy.updateTrailingStop(trade, makeCandle(2, 105, 110, 104, 108), atrVal);
    stops.push(trade.trailingStop);

    // Price pulls back → trail must NOT decrease
    strategy.updateTrailingStop(trade, makeCandle(3, 108, 109, 102, 103), atrVal);
    stops.push(trade.trailingStop);

    strategy.updateTrailingStop(trade, makeCandle(4, 103, 104, 100, 101), atrVal);
    stops.push(trade.trailingStop);

    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]).toBeGreaterThanOrEqual(stops[i - 1]);
    }
  });

  it('short trailing stop only moves DOWN, never up', () => {
    const config = { ...CONFIG } as typeof CONFIG;
    const logger = new StrategyLogger(null);
    const exchange = new SimExchangeClient(10_000);
    const riskService = new RiskService(config, logger, exchange);
    const executionService = new ExecutionService(config, logger, exchange);
    const universeService = new UniverseService(config, logger);
    const strategy = new DonchianBreakout15m(
      config, logger, exchange, riskService, executionService, universeService,
    );

    const trade: TradeState = {
      symbol: 'TEST',
      side: 'short',
      entryPrice: 100,
      entryTime: 0,
      size: 1,
      leverage: 5,
      initialStop: 104,
      trailingStop: 106,
      atrAtEntry: 2,
      riskAmount: 25,
      executionPath: 'MAKER_FILLED',
    };

    const atrVal = 2;
    const stops: number[] = [trade.trailingStop];

    // Price goes down → trail should move down
    strategy.updateTrailingStop(trade, makeCandle(1, 100, 101, 94, 95), atrVal);
    stops.push(trade.trailingStop);

    strategy.updateTrailingStop(trade, makeCandle(2, 95, 96, 90, 92), atrVal);
    stops.push(trade.trailingStop);

    // Price bounces → trail must NOT increase
    strategy.updateTrailingStop(trade, makeCandle(3, 92, 97, 91, 96), atrVal);
    stops.push(trade.trailingStop);

    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]).toBeLessThanOrEqual(stops[i - 1]);
    }
  });

  it('trail uses Chandelier formula: close - trailAtrMult * ATR for long', () => {
    const config = { ...CONFIG, trailAtrMult: 3.0 } as typeof CONFIG;
    const logger = new StrategyLogger(null);
    const exchange = new SimExchangeClient(10_000);
    const riskService = new RiskService(config, logger, exchange);
    const executionService = new ExecutionService(config, logger, exchange);
    const universeService = new UniverseService(config, logger);
    const strategy = new DonchianBreakout15m(
      config, logger, exchange, riskService, executionService, universeService,
    );

    const trade: TradeState = {
      symbol: 'TEST',
      side: 'long',
      entryPrice: 100,
      entryTime: 0,
      size: 1,
      leverage: 5,
      initialStop: 90,
      trailingStop: 85,
      atrAtEntry: 5,
      riskAmount: 25,
      executionPath: 'MAKER_FILLED',
    };

    const currentAtr = 5;
    const candle = makeCandle(1, 100, 120, 99, 115);
    strategy.updateTrailingStop(trade, candle, currentAtr);

    // Expected: max(85, 115 - 3.0 * 5) = max(85, 100) = 100
    expect(trade.trailingStop).toBe(100);
  });
});
