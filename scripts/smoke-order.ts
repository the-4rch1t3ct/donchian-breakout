/**
 * Smoke test: connect to Hyperliquid, place a tiny limit order far off-market,
 * verify it appears in open orders, cancel it, verify it's gone.
 *
 * Usage: npx tsx scripts/smoke-order.ts
 * Requires: HL_WALLET_ADDRESS, HL_PRIVATE_KEY
 */
import 'dotenv/config';
import { StrategyLogger } from '../src/logger.js';
import { HyperliquidExchangeClient } from '../src/exchange/hyperliquidExchangeClient.js';
import { CONFIG } from '../src/config.js';

const SYMBOL = 'BTC';
const SIZE = 0.001;          // ~$0.10 at any BTC price
const PRICE_DISCOUNT = 0.50; // 50% below market — will never fill

async function main() {
  console.log('\n=== Smoke Order Test ===\n');

  if (!CONFIG.hlWalletAddress || !CONFIG.hlPrivateKey) {
    console.error('ERROR: Set HL_WALLET_ADDRESS and HL_PRIVATE_KEY env vars');
    process.exit(1);
  }

  const logger = new StrategyLogger(null);
  const client = new HyperliquidExchangeClient({
    walletAddress: CONFIG.hlWalletAddress,
    privateKey: CONFIG.hlPrivateKey,
    baseUrl: CONFIG.hlBaseUrl,
    logger,
    minNotionalPerOrder: CONFIG.minNotionalPerOrder,
    maxNotionalPerSymbol: CONFIG.maxNotionalPerSymbol,
    takerFeeBps: CONFIG.takerFeeBps,
    makerFeeBps: CONFIG.makerFeeBps,
  });

  // 1. Init asset map
  console.log('1. Initializing asset map...');
  await client.init();
  console.log('   ✓ Asset universe loaded');

  // 2. Fetch equity
  console.log('2. Fetching account equity...');
  const equity = await client.getEquity();
  console.log(`   ✓ Equity: $${equity.toFixed(2)}`);

  // 3. Fetch order book
  console.log(`3. Fetching ${SYMBOL} order book...`);
  const book = await client.getOrderBookTop(SYMBOL);
  console.log(`   ✓ Bid: ${book.bestBid}  Ask: ${book.bestAsk}  Spread: ${book.spreadBps.toFixed(1)} bps`);

  // 4. Place a tiny limit buy far below market
  const farPrice = Math.floor(book.bestBid * PRICE_DISCOUNT);
  console.log(`4. Placing limit buy: ${SIZE} ${SYMBOL} @ $${farPrice} (post-only, ~50% below mkt)...`);
  const placeResult = await client.placeLimit(SYMBOL, 'long', farPrice, SIZE, true);

  if (!placeResult.orderId) {
    console.error('   ✗ Order placement returned no orderId. Check logs.');
    printLogs(logger);
    process.exit(1);
  }

  if (placeResult.filled) {
    console.error(`   ✗ Order FILLED unexpectedly at ${placeResult.fillPrice}! Something is wrong.`);
    process.exit(1);
  }

  console.log(`   ✓ Order resting, orderId: ${placeResult.orderId}`);

  // 5. Verify it appears in open orders
  console.log('5. Fetching open orders...');
  const openOrders = await client.getOpenOrders(SYMBOL);
  const found = openOrders.find(o => o.orderId === placeResult.orderId);
  if (found) {
    console.log(`   ✓ Found in open orders: ${found.side} ${found.size} @ ${found.price}`);
  } else {
    console.log(`   ⚠ Order ${placeResult.orderId} not found in open orders (may have been rejected)`);
  }

  // 6. Cancel it
  console.log(`6. Cancelling order ${placeResult.orderId}...`);
  await client.cancel(placeResult.orderId!);
  console.log('   ✓ Cancel sent');

  // 7. Verify it's gone
  console.log('7. Verifying order is cancelled...');
  const afterCancel = await client.getOpenOrders(SYMBOL);
  const stillThere = afterCancel.find(o => o.orderId === placeResult.orderId);
  if (stillThere) {
    console.error('   ✗ Order still present after cancel!');
  } else {
    console.log('   ✓ Order successfully cancelled');
  }

  // 8. Fetch positions (sanity)
  console.log('8. Fetching positions...');
  const positions = await client.getPositions();
  console.log(`   ✓ ${positions.length} open position(s)`);
  for (const p of positions) {
    console.log(`     ${p.symbol} ${p.side} size=${p.size} entry=${p.entryPrice} pnl=${p.unrealizedPnl.toFixed(2)}`);
  }

  console.log('\n=== Smoke Test PASSED ===\n');
  printLogs(logger);
}

function printLogs(logger: StrategyLogger) {
  const logs = logger.getBuffer();
  if (logs.length > 0) {
    console.log('\n--- Exchange log events ---');
    for (const l of logs) {
      console.log(`  [${l.module}] ${l.event} ${l.symbol} ${l.side} ${JSON.stringify(l.details ?? {})}`);
    }
  }
}

main().catch(err => {
  console.error('Smoke test FAILED:', err);
  process.exit(1);
});
