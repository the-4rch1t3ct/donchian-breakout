/**
 * Kill-switch drill: verifies the entire kill-switch path works end-to-end.
 *
 * Runs locally with SimExchangeClient (no network needed).
 * Simulates a -3.1% intraday DD and verifies:
 *   1. HARD_KILL_SWITCH_TRIGGERED fires
 *   2. KILL_SWITCH_TRIGGERED fires
 *   3. cancelAll() is called
 *   4. FLATTEN_ALL fires
 *   5. No new entries are accepted after kill
 *
 * Usage: npx tsx scripts/kill-switch-drill.ts
 */
import { CONFIG } from '../src/config.js';
import { StrategyLogger } from '../src/logger.js';
import { SimExchangeClient } from '../src/exchange/simExchangeClient.js';
import { RiskService } from '../src/services/riskService.js';
import { ExecutionService } from '../src/services/executionService.js';
import { UniverseService } from '../src/services/universeService.js';
import { Runner } from '../src/runner.js';

function makeCandle(ts: number, o: number, h: number, l: number, c: number) {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

async function main() {
  console.log('\n=== Kill-Switch Drill ===\n');

  const config = { ...CONFIG, defaultSymbols: ['BTC', 'ETH'], hardDdThreshold: -0.03 } as typeof CONFIG;
  const logger = new StrategyLogger(null);

  // Starting equity: $10,000. We'll simulate a drop to $9,690 (-3.1%)
  const exchange = new SimExchangeClient(9_690);
  const riskService = new RiskService(config, logger, exchange);
  const executionService = new ExecutionService(config, logger, exchange);
  const universeService = new UniverseService(config, logger);
  universeService.setSymbols(['BTC', 'ETH']);

  // Feed candles so the exchange can respond to getOrderBookTop / getCandles
  const now = Date.now();
  const candles = [];
  for (let i = 0; i < 100; i++) {
    candles.push(makeCandle(now - (100 - i) * 900_000, 40000, 40200, 39800, 40000 + i));
  }
  exchange.feedCandles('BTC', candles);
  exchange.feedCandles('ETH', candles.map(c => ({
    ...c, open: c.open / 16, high: c.high / 16, low: c.low / 16, close: c.close / 16,
  })));
  exchange.setCurrentCandle('BTC', candles[candles.length - 1]);
  exchange.setCurrentCandle('ETH', candles[candles.length - 1]);

  // Init day with equity_at_start = $10,000 (but current equity is $9,690)
  await riskService.initDay(now, 10_000);

  console.log('Setup:');
  console.log(`  Equity at UTC midnight:  $10,000`);
  console.log(`  Current equity:          $9,690  (DD = -3.1%)`);
  console.log(`  Hard kill threshold:     -3.0%`);
  console.log();

  const runner = new Runner({
    config,
    logger,
    exchange,
    riskService,
    executionService,
    universeService,
    mode: 'paper',
  });

  // Run one tick — should trigger the kill switch
  console.log('Running tick...\n');
  await runner.tick();

  // Analyze results
  const logs = logger.getBuffer();
  const events = logs.map(l => l.event);

  const checks = [
    { name: 'HARD_KILL_SWITCH_TRIGGERED', pass: events.includes('HARD_KILL_SWITCH_TRIGGERED') },
    { name: 'KILL_SWITCH_TRIGGERED',      pass: events.includes('KILL_SWITCH_TRIGGERED') },
    { name: 'ORDER_CANCELLED (cancelAll)', pass: events.includes('ORDER_CANCELLED') },
    { name: 'FLATTEN_ALL',                 pass: events.includes('FLATTEN_ALL') },
  ];

  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗';
    console.log(`  ${icon}  ${check.name}`);
    if (!check.pass) allPassed = false;
  }

  // Verify entries are disabled
  console.log();
  console.log('Post-kill state:');
  console.log(`  isKilled():    ${riskService.isKilled()}`);
  console.log(`  getSizeMult(): ${riskService.getSizeMult()}`);

  const killCheck = riskService.isKilled() && riskService.getSizeMult() === 0;
  const icon = killCheck ? '✓' : '✗';
  console.log(`  ${icon}  Entries disabled (sizeMult=0)`);
  if (!killCheck) allPassed = false;

  // Verify new entries would be blocked
  logger.clearBuffer();
  await runner.tick();
  const postKillLogs = logger.getBuffer();
  const anyNewEntry = postKillLogs.some(l => l.event === 'POSITION_OPENED');
  const blockIcon = anyNewEntry ? '✗' : '✓';
  console.log(`  ${blockIcon}  No new entries after kill switch`);
  if (anyNewEntry) allPassed = false;

  console.log();
  if (allPassed) {
    console.log('=== Kill-Switch Drill PASSED ===\n');
  } else {
    console.log('=== Kill-Switch Drill FAILED ===\n');
    console.log('Event log:');
    for (const l of logs) {
      console.log(`  [${l.module}] ${l.event} ${l.symbol} ${l.side}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Kill-switch drill error:', err);
  process.exit(1);
});
