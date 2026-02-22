import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { RiskService } from '../src/services/riskService.js';

describe('UTC day boundary handling', () => {
  function makeRiskService(equity = 10_000) {
    const config = { ...CONFIG } as typeof CONFIG;
    const logger = new StrategyLogger(null);
    const exchange = new SimExchangeClient(equity);
    return { riskService: new RiskService(config, logger, exchange), exchange, logger, config };
  }

  it('getUtcDayStartMs returns midnight UTC', () => {
    const { riskService } = makeRiskService();
    // 2025-03-15 14:30:00 UTC
    const ts = Date.UTC(2025, 2, 15, 14, 30, 0);
    const dayStart = riskService.getUtcDayStartMs(ts);
    expect(dayStart).toBe(Date.UTC(2025, 2, 15, 0, 0, 0));
  });

  it('detects day boundary crossing', async () => {
    const { riskService } = makeRiskService();
    const day1 = Date.UTC(2025, 0, 1, 23, 59, 0);
    await riskService.initDay(day1, 10_000);

    expect(riskService.checkDayBoundary(day1)).toBe(false);
    expect(riskService.checkDayBoundary(Date.UTC(2025, 0, 2, 0, 0, 1))).toBe(true);
  });

  it('computes drawdown correctly', async () => {
    const { riskService } = makeRiskService();
    await riskService.initDay(Date.UTC(2025, 0, 1), 10_000);

    expect(riskService.computeDD(10_000)).toBe(0);
    expect(riskService.computeDD(9_900)).toBeCloseTo(-0.01, 6);
    expect(riskService.computeDD(9_700)).toBeCloseTo(-0.03, 6);
    expect(riskService.computeDD(10_100)).toBeCloseTo(0.01, 6);
  });

  it('triggers hard kill at -3% DD', async () => {
    const { riskService, exchange } = makeRiskService(9_700);
    await riskService.initDay(Date.UTC(2025, 0, 1), 10_000);

    const result = await riskService.updateDailyDD(Date.UTC(2025, 0, 1, 12, 0, 0));
    expect(result.hardKill).toBe(true);
    expect(riskService.isKilled()).toBe(true);
  });

  it('triggers soft brake at -1.5% DD', async () => {
    const { riskService } = makeRiskService(9_850);
    await riskService.initDay(Date.UTC(2025, 0, 1), 10_000);

    const result = await riskService.updateDailyDD(Date.UTC(2025, 0, 1, 12, 0, 0));
    expect(result.softBrake).toBe(true);
    expect(result.hardKill).toBe(false);
    expect(riskService.isSoftBrake()).toBe(true);
    expect(riskService.getSizeMult()).toBe(0.5);
  });

  it('resets kill switch on new UTC day', async () => {
    const { riskService } = makeRiskService(9_700);
    await riskService.initDay(Date.UTC(2025, 0, 1), 10_000);

    await riskService.updateDailyDD(Date.UTC(2025, 0, 1, 12, 0, 0));
    expect(riskService.isKilled()).toBe(true);

    // New day
    await riskService.initDay(Date.UTC(2025, 0, 2), 9_700);
    expect(riskService.isKilled()).toBe(false);
    expect(riskService.getSizeMult()).toBe(1);
  });

  it('position sizing respects risk_per_trade and sizeMult', () => {
    const { riskService } = makeRiskService();
    const result = riskService.computePositionSize(10_000, 0.02, 1.0);
    // riskAmount = 10000 * 0.0025 * 1.0 = 25
    // notional = 25 / 0.02 = 1250
    expect(result.size).toBeCloseTo(1250, 0);
    expect(result.leverage).toBe(5);
  });

  it('position sizing halved under soft brake', () => {
    const { riskService } = makeRiskService();
    const full = riskService.computePositionSize(10_000, 0.02, 1.0);
    const half = riskService.computePositionSize(10_000, 0.02, 0.5);
    expect(half.size).toBeCloseTo(full.size / 2, 0);
  });
});
