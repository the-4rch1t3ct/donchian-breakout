/**
 * Log monitor: reads the JSONL log and prints key metrics.
 *
 * Usage: npx tsx scripts/log-stats.ts [logfile]
 * Default logfile: ./logs/donchian_breakout.jsonl
 *
 * Shows:
 *   - Event counts by module/event
 *   - Maker vs taker fill %
 *   - Slippage distribution
 *   - Fee totals
 *   - API error frequency
 *   - Skipped trade reasons
 *   - Win/loss stats
 *   - widthPct P50/P90 on ENTRY_SIGNAL vs SKIPPED_LOW_ATR_PCT/NO_SIGNAL (for WIDTH_PCT_MIN tuning)
 */
import * as fs from 'node:fs';

interface LogEntry {
  timestamp: string;
  symbol: string;
  side: string;
  module: string;
  event: string;
  executionPath?: string;
  exitReason?: string;
  slippageBps?: number;
  fees?: number;
  realizedR?: number;
  details?: Record<string, unknown>;
  signalParams?: { widthPct?: number; [k: string]: unknown };
}

function main() {
  const logFile = process.argv[2] ?? './logs/donchian_breakout.jsonl';

  if (!fs.existsSync(logFile)) {
    console.log(`No log file found at ${logFile}`);
    console.log('Start the bot first, then run this script.');
    process.exit(0);
  }

  const raw = fs.readFileSync(logFile, 'utf-8').trim();
  if (!raw) {
    console.log('Log file is empty.');
    process.exit(0);
  }

  const lines = raw.split('\n');
  const entries: LogEntry[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }

  console.log(`\n=== Log Stats: ${logFile} ===`);
  console.log(`Total entries: ${entries.length}  (parse errors: ${parseErrors})\n`);

  if (entries.length === 0) return;

  const first = entries[0].timestamp;
  const last = entries[entries.length - 1].timestamp;
  console.log(`Time range: ${first} → ${last}\n`);

  // ── Event counts ──────────────────────────────────────
  const eventCounts = new Map<string, number>();
  for (const e of entries) {
    const key = `[${e.module}] ${e.event}`;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }

  console.log('── Event Counts ──');
  const sorted = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [event, count] of sorted) {
    console.log(`  ${String(count).padStart(5)}  ${event}`);
  }

  // ── Execution path breakdown ──────────────────────────
  const pathCounts = new Map<string, number>();
  for (const e of entries) {
    if (e.executionPath) {
      pathCounts.set(e.executionPath, (pathCounts.get(e.executionPath) ?? 0) + 1);
    }
  }

  if (pathCounts.size > 0) {
    console.log('\n── Execution Paths ──');
    const total = [...pathCounts.values()].reduce((a, b) => a + b, 0);
    for (const [path, count] of [...pathCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = ((count / total) * 100).toFixed(1);
      console.log(`  ${String(count).padStart(5)}  ${path}  (${pct}%)`);
    }

    const makerFills = pathCounts.get('MAKER_FILLED') ?? 0;
    const takerFills = pathCounts.get('MAKER_TIMEOUT_TAKER') ?? 0;
    const totalFills = makerFills + takerFills;
    if (totalFills > 0) {
      console.log(`\n  Maker fill rate: ${((makerFills / totalFills) * 100).toFixed(1)}%`);
    }
  }

  // ── Slippage distribution ─────────────────────────────
  const slippages = entries.filter(e => e.slippageBps !== undefined).map(e => e.slippageBps!);
  if (slippages.length > 0) {
    slippages.sort((a, b) => a - b);
    const avg = slippages.reduce((a, b) => a + b, 0) / slippages.length;
    const p50 = slippages[Math.floor(slippages.length * 0.5)];
    const p90 = slippages[Math.floor(slippages.length * 0.9)];
    const max = slippages[slippages.length - 1];

    console.log('\n── Slippage (bps) ──');
    console.log(`  Entries:  ${slippages.length}`);
    console.log(`  Avg:      ${avg.toFixed(2)}`);
    console.log(`  P50:      ${p50.toFixed(2)}`);
    console.log(`  P90:      ${p90.toFixed(2)}`);
    console.log(`  Max:      ${max.toFixed(2)}`);
  }

  // ── Fees ──────────────────────────────────────────────
  const totalFees = entries
    .filter(e => e.fees !== undefined)
    .reduce((sum, e) => sum + e.fees!, 0);
  if (totalFees > 0) {
    console.log(`\n── Fees ──`);
    console.log(`  Total fees: $${totalFees.toFixed(2)}`);
  }

  // ── API errors ────────────────────────────────────────
  const apiErrors = entries.filter(e => e.event === 'EXCHANGE_API_ERROR');
  if (apiErrors.length > 0) {
    console.log(`\n── API Errors ──`);
    console.log(`  Total: ${apiErrors.length}`);
    const errorMethods = new Map<string, number>();
    for (const e of apiErrors) {
      const method = (e.details?.method as string) ?? 'unknown';
      errorMethods.set(method, (errorMethods.get(method) ?? 0) + 1);
    }
    for (const [method, count] of [...errorMethods.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)}  ${method}`);
    }
  }

  // ── widthPct by signal type (for tuning WIDTH_PCT_MIN) ──
  function percentile(sorted: number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  }
  function widthStats(arr: number[], withLowEnd: boolean): { n: number; p50: number; p90: number; p10?: number; p25?: number } | null {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const out: { n: number; p50: number; p90: number; p10?: number; p25?: number } = {
      n: arr.length,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
    };
    if (withLowEnd) {
      out.p10 = percentile(sorted, 0.1);
      out.p25 = percentile(sorted, 0.25);
    }
    return out;
  }
  const entrySignalWidths = entries
    .filter(e => e.event === 'ENTRY_SIGNAL' && typeof e.signalParams?.widthPct === 'number')
    .map(e => e.signalParams!.widthPct!);
  const skippedWidths = entries
    .filter(e =>
      (e.event === 'SKIPPED_LOW_ATR_PCT' || e.event === 'NO_SIGNAL') &&
      typeof e.signalParams?.widthPct === 'number',
    )
    .map(e => e.signalParams!.widthPct!);
  const entryStats = widthStats(entrySignalWidths, true);
  const skippedStats = widthStats(skippedWidths, false);
  if (entryStats || skippedStats) {
    console.log('\n── widthPct (Donchian channel width %) ──');
    if (entryStats) {
      const low = entryStats.p10 != null && entryStats.p25 != null
        ? `  P10=${(entryStats.p10 * 100).toFixed(2)}%  P25=${(entryStats.p25 * 100).toFixed(2)}%  `
        : '';
      console.log(`  ENTRY_SIGNAL bars:        n=${entryStats.n}  ${low}P50=${(entryStats.p50 * 100).toFixed(2)}%  P90=${(entryStats.p90 * 100).toFixed(2)}%`);
    }
    if (skippedStats) {
      console.log(`  SKIPPED_LOW_ATR_PCT / NO_SIGNAL: n=${skippedStats.n}  P50=${(skippedStats.p50 * 100).toFixed(2)}%  P90=${(skippedStats.p90 * 100).toFixed(2)}%`);
    }
    if (entryStats && skippedStats) {
      console.log('  → WIDTH_PCT_MIN: aim between SKIP_P90 and ENTRY_P25 (or between the two P50s). Need n≥30 ENTRY_SIGNAL then test in paper 6–12h.');
    }
  }

  // ── Skipped entries ───────────────────────────────────
  const skipped = entries.filter(e =>
    e.event.startsWith('SKIPPED_') || e.event === 'NO_SIGNAL',
  );
  if (skipped.length > 0) {
    console.log('\n── Skipped Entries ──');
    const skipReasons = new Map<string, number>();
    for (const e of skipped) {
      skipReasons.set(e.event, (skipReasons.get(e.event) ?? 0) + 1);
    }
    const totalSkipped = skipped.length;
    for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = ((count / totalSkipped) * 100).toFixed(1);
      console.log(`  ${String(count).padStart(5)}  ${reason}  (${pct}%)`);
    }
  }

  // ── Trade results ─────────────────────────────────────
  const closes = entries.filter(e => e.event === 'POSITION_CLOSED' && e.realizedR !== undefined);
  if (closes.length > 0) {
    const wins = closes.filter(e => e.realizedR! > 0);
    const losses = closes.filter(e => e.realizedR! <= 0);
    const totalR = closes.reduce((sum, e) => sum + e.realizedR!, 0);
    const avgR = totalR / closes.length;

    console.log('\n── Trade Results ──');
    console.log(`  Total trades:  ${closes.length}`);
    console.log(`  Wins/Losses:   ${wins.length}/${losses.length}`);
    console.log(`  Win rate:      ${((wins.length / closes.length) * 100).toFixed(1)}%`);
    console.log(`  Total R:       ${totalR.toFixed(2)}`);
    console.log(`  Avg R:         ${avgR.toFixed(2)}`);

    // Exit reason breakdown
    const exitReasons = new Map<string, number>();
    for (const e of closes) {
      const reason = e.exitReason ?? 'unknown';
      exitReasons.set(reason, (exitReasons.get(reason) ?? 0) + 1);
    }
    console.log('\n  Exit reasons:');
    for (const [reason, count] of [...exitReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)}  ${reason}`);
    }
  }

  // ── Kill switch events ────────────────────────────────
  const killEvents = entries.filter(e =>
    e.event === 'KILL_SWITCH_TRIGGERED' ||
    e.event === 'HARD_KILL_SWITCH_TRIGGERED' ||
    e.event === 'FLATTEN_ALL',
  );
  if (killEvents.length > 0) {
    console.log('\n── Kill Switch Events ──');
    for (const e of killEvents) {
      console.log(`  ${e.timestamp}  ${e.event}`);
    }
  }

  console.log();
}

main();
