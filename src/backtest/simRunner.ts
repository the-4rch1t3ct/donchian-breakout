import type { Candle } from '../types/index.js';
import { SimHarness } from './simHarness.js';

function generateSyntheticCandles(
  bars: number,
  startPrice: number,
  volatility: number,
  trendStrength: number,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const startTime = Date.UTC(2025, 0, 1);

  for (let i = 0; i < bars; i++) {
    const trend = trendStrength * (Math.random() > 0.5 ? 1 : -1);
    const noise = (Math.random() - 0.5) * 2 * volatility * price;
    const open = price;
    const close = price + noise + trend * price;
    const high = Math.max(open, close) + Math.random() * volatility * price * 0.5;
    const low = Math.min(open, close) - Math.random() * volatility * price * 0.5;

    candles.push({
      timestamp: startTime + i * 15 * 60 * 1000,
      open: Math.max(0.01, open),
      high: Math.max(0.01, high),
      low: Math.max(0.01, low),
      close: Math.max(0.01, close),
      volume: 1000 + Math.random() * 5000,
    });

    price = close;
  }
  return candles;
}

async function main(): Promise<void> {
  console.log('=== Donchian Breakout 15m Sim ===\n');

  const harness = new SimHarness(undefined, 10_000);

  const candleMap = new Map<string, Candle[]>();
  candleMap.set('BTC', generateSyntheticCandles(500, 42000, 0.008, 0.001));
  candleMap.set('ETH', generateSyntheticCandles(500, 2500, 0.012, 0.0008));
  candleMap.set('SOL', generateSyntheticCandles(500, 100, 0.02, 0.002));

  const result = await harness.run(candleMap);

  console.log(`Total bars:       ${result.totalBars}`);
  console.log(`Total trades:     ${result.totalTrades}`);
  console.log(`Win/Loss:         ${result.winCount}/${result.lossCount}`);
  console.log(`Win rate:         ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`Total R:          ${result.totalR.toFixed(2)}`);
  console.log(`Avg R:            ${result.avgR.toFixed(2)}`);
  console.log(`Max DD:           ${(result.maxDD * 100).toFixed(2)}%`);
  console.log(`Final equity:     ${result.finalEquity.toFixed(2)}`);
  console.log(`\n--- Trades ---`);
  for (const t of result.trades) {
    console.log(`  ${t.symbol} ${t.side} entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} R=${t.realizedR.toFixed(2)} reason=${t.exitReason}`);
  }
}

main().catch(console.error);
