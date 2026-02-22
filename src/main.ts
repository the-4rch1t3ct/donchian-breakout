import 'dotenv/config';
import { CONFIG } from './config.js';
import { StrategyLogger } from './logger.js';
import { RiskService } from './services/riskService.js';
import { ExecutionService } from './services/executionService.js';
import { UniverseService } from './services/universeService.js';
import { Runner, createExchangeClient } from './runner.js';
import type { TradingMode } from './types/index.js';

async function main(): Promise<void> {
  const mode = CONFIG.mode as TradingMode;
  console.log(`\n=== Donchian Breakout 15m — mode: ${mode.toUpperCase()} ===\n`);

  if (mode === 'sim') {
    await import('./backtest/simRunner.js');
    return;
  }

  const logger = new StrategyLogger(CONFIG.logFilePath);
  const exchange = await createExchangeClient(mode, CONFIG, logger);

  const riskService = new RiskService(CONFIG, logger, exchange);
  const executionService = new ExecutionService(CONFIG, logger, exchange);
  const universeService = new UniverseService(CONFIG, logger);

  const runner = new Runner({
    config: CONFIG,
    logger,
    exchange,
    riskService,
    executionService,
    universeService,
    mode,
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    await runner.stop();
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await runner.start();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
