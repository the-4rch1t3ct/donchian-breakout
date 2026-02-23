# Donchian Breakout 15m — Hyperliquid Perps

Close-confirmed Donchian channel breakout strategy with strict risk controls, maker-first execution, and audit-grade logging.

Supports three modes: **sim** (backtest), **paper** (live prices, simulated fills), and **live** (real trading on Hyperliquid).

## Quick Start

```bash
npm install
npm test              # 55 unit tests
npm run sim           # synthetic backtest
npm run paper         # paper trading with live HL data
npm run live          # live trading (requires env vars)
```

## Entry Rules

**Signal timeframe:** 15-minute (close-confirmed).

| Condition | Long | Short |
|-----------|------|-------|
| Donchian break | `close_15m >= DonchianHigh(N) * (1 + buffer_bps/10000)` | `close_15m <= DonchianLow(N) * (1 - buffer_bps/10000)` |
| Donchian lookback | N=20 candles (configurable 15–30) | Same |
| Buffer | 3 bps default (configurable 2–8) | Same |

### Regime Filter (all must pass)

| Filter | Normal | Soft Brake (DD <= -1.5%) |
|--------|--------|--------------------------|
| ATR% | >= 0.40% | >= 0.55% |
| ADX | >= 22 | >= 26 |
| Candle range / ATR | <= 2.0 | <= 1.7 |

### ATR% chaos ceiling (on by default)

Avoids entering during extreme volatility (news spike / chaos regime), where spreads and whipsaws blow you up. If ATR% is **above** the configured max, the bar is skipped with `SKIPPED_HIGH_ATR_PCT`.

| Env / config | Default | Description |
|--------------|---------|-------------|
| `ATR_PCT_MAX` | 0.02 (2%) | Max ATR% allowed; e.g. `0.03` = 3%. Set very high or leave unset to use default 2%. |
| `ATR_PCT_MAX_SOFT` | same as `ATR_PCT_MAX` | Max ATR% when in soft brake (DD ≤ -1.5%). |

Typical range 2–3%. Set `ATR_PCT_MAX=0.03` for a looser cap, or a high value to effectively disable.

### Donchian width % (optional, off by default)

Channel width is logged on every strategy line as `signalParams.widthPct`: `(upper - lower) / mid` on the same N-bar lookback used for the bands. It can be used as a quality filter so entries only fire when the channel is wide enough (e.g. avoid flat, ranging markets).

| Env / config | Default | Description |
|--------------|---------|-------------|
| `ENABLE_WIDTH_FILTER` | `false` | Set to `true` to enable the width filter. |
| `WIDTH_PCT_MIN` | 0 | Minimum width (e.g. `0.01` = 1%). |
| `WIDTH_PCT_MIN_SOFT` | same as `WIDTH_PCT_MIN` | Minimum width when in soft brake (DD ≤ -1.5%). |

When enabled: baseline requires `widthPct >= WIDTH_PCT_MIN`; under soft brake requires `widthPct >= WIDTH_PCT_MIN_SOFT`. If the filter fails, the strategy logs `SKIPPED_LOW_WIDTH_PCT` with `widthPct` and `threshold` in `details`. For crypto 15m, a typical range is 0.008–0.020 (0.8%–2.0%); tune via env, no code change.

**Suggested workflow:** Keep `ENABLE_WIDTH_FILTER=false` at first so every bar logs `signalParams.widthPct` (NO_SIGNAL, SKIPPED_*, ENTRY_SIGNAL). After ~24h, compare the distribution of `widthPct` on: (a) bars that would have signaled vs no-signal, (b) bars that pass ATR%/ADX vs fail. Then choose a threshold that filters chop without starving trades. **Quick paper-test starting point:** `ENABLE_WIDTH_FILTER=true`, `WIDTH_PCT_MIN=0.010` (1.0%), `WIDTH_PCT_MIN_SOFT=0.012` (1.2%).

### Cooldown

After a stop-out on `symbol+direction`, wait 5 bars (15m) before re-entry in the same direction.

## Exit Rules

- **Initial stop:** `entry ± 2.0 * ATR_15m` (no take-profit; winners run)
- **Trailing stop (Chandelier):** Updated each 15m bar:
  - Long: `trail = max(prev_trail, close - 3.0 * ATR_15m)`
  - Short: `trail = min(prev_trail, close + 3.0 * ATR_15m)`
- Trailing stop is monotonic: only tightens, never loosens.

## Risk Controls

### Per-Trade Sizing

- `risk_per_trade = 0.25%` of equity (base)
- Position size = `(equity * risk_per_trade * size_mult) / stop_distance_pct`
- Default leverage: 5x (up to 10x if `liq_distance >= 2 * stop_distance`)

### Portfolio Caps

- Max open risk: 1.0% of equity
- Max concurrent positions: 6
- Max per cluster: 2
- **Max notional per symbol: $1,500** (configurable safety cap)

### UTC-Day Drawdown Controls

| Threshold | Action |
|-----------|--------|
| DD <= -1.5% | **Soft brake:** size_mult=0.5, tighter filters |
| DD <= -3.0% | **Hard kill:** flatten ALL, cancel ALL, disable entries until next UTC day |

DD = `(current_equity - equity_at_UTC_midnight) / equity_at_UTC_midnight`

## Execution Model

After a 15m signal fires, within a 5-minute entry window (paper/live only; sim uses instant fill):

1. **Microstructure guards** (1m data):
   - Spread <= 10 bps
   - Estimated slippage <= 8 bps
   - No 1m candle in last 3 minutes with `range > 3 * ATR_1m`
2. **Maker limit** (post-only ALO) slightly improved from top-of-book. Wait up to **maker timeout** (default **2 s**, `MAKER_TIMEOUT_MS`). If filled → done.
3. If not filled: cancel the maker (log `ORDER_CANCELLED`, reason `CANCEL_TIMEOUT`), **re-check** microstructure. If guards fail → skip and log (no IOC).
4. **IOC fallback**: submit a marketable limit (IOC) with a **max slippage cap** (default **8 bps**, `IOC_MAX_SLIPPAGE_BPS`): long limit = bestAsk × (1 + slippage_bps/10000), short = bestBid × (1 − slippage_bps/10000). If filled (or partial) → success; else log `ORDER_FAILED` and treat entry as skipped.

All order actions are written to the JSONL log (module `EXCHANGE`): `ORDER_PLACED`, `ORDER_CANCELLED`, `ORDER_FILLED`, `ORDER_FAILED` with audit fields (orderType, reason, attempt, price, size, notional, spreadBps, fillPrice/fees/slippageBps for fills). No secrets are logged.

## Trading Modes

### Sim (`MODE=sim`)

Runs a backtest with synthetic data using `SimExchangeClient`. No external connections.

```bash
npm run sim
```

### Paper (`MODE=paper`)

Uses live Hyperliquid orderbook/candle data via `PaperExchangeClient` but simulates fills locally. Paper state persists to `./data/paper_state.json` so restarts don't reset the account.

Requires `HL_WALLET_ADDRESS` (for market data access, though no signing needed for reads).

```bash
MODE=paper npm start
```

### Live (`MODE=live`)

Trades with real money on Hyperliquid via `HyperliquidExchangeClient`.

```bash
MODE=live LIVE_TRADING=true npm start
```

**Safety switches for live mode:**

| Guard | Behavior |
|-------|----------|
| `LIVE_TRADING=true` | Required env var — exits immediately without it |
| Startup checks | Logs config snapshot (redacted), fetches equity + positions, verifies orderbook connectivity for all symbols |
| Max notional per symbol | Rejects any order exceeding `maxNotionalPerSymbol` ($1.5k default) |
| Daily kill switch | At -3% UTC-day DD: cancels all open orders, flattens all positions via IOC, disables entries until next UTC day |
| Post-only enforcement | Maker orders always use `Alo` (add-liquidity-only) — never a non-post-only "maker" |
| API error default | Any exchange API failure logs a structured event and defaults to "do nothing" |

## Required Environment Variables

| Variable | Required for | Description |
|----------|-------------|-------------|
| `MODE` | all | `sim`, `paper`, or `live` (default: `sim`) |
| `HL_WALLET_ADDRESS` | paper, live | Hyperliquid wallet address (0x...) |
| `HL_PRIVATE_KEY` | live | Wallet private key for signing (0x...) |
| `HL_BASE_URL` | optional | API URL (defaults to mainnet) |
| `LIVE_TRADING` | live | Must be `true` to enable live trading |

Copy `.env.example` to `.env` and fill in your values.

## Launch Checklist (before going live)

### 1. Paper burn-in (30–60 min)

```bash
npm run paper
```

Confirm: ticking on 15m boundaries, maker/taker behavior in logs, no API errors, `paper_state.json` persists across restart.

### 2. Smoke test (place + cancel on HL)

```bash
npm run smoke
```

Places a tiny limit order far off-market, verifies it shows in open orders, cancels it, verifies it's gone. Requires `HL_WALLET_ADDRESS` + `HL_PRIVATE_KEY`.

### 3. Kill-switch drill (no network needed)

```bash
npm run drill:kill
```

Forces a -3.1% DD in simulation and verifies the full kill-switch chain: `HARD_KILL_SWITCH_TRIGGERED` → `KILL_SWITCH_TRIGGERED` → `cancelAll()` → `FLATTEN_ALL` → entries disabled.

### 4. First 24 hours: conservative settings

Copy `.env.first24h` to `.env` and fill in your credentials. Training-wheel defaults:

| Setting | First 24h | Normal |
|---------|-----------|--------|
| `RISK_PER_TRADE` | 0.10% | 0.25% |
| `MAX_CONCURRENT` | 2 | 6 |
| `MAX_LEVERAGE` | 5 | 10 |
| `MAX_NOTIONAL` | $1.5k | $1.5k |

All risk params are now env-overridable — no code changes needed.

### 5. Monitor live logs

```bash
npm run logs
# or: npm run logs -- ./path/to/other.jsonl
```

Shows: event counts, maker fill % vs taker fallback, slippage distribution (P50/P90/max), API error frequency, skipped trades by reason, trade results (win rate, total R, exit reasons), kill-switch events.

## Configuration

All parameters live in `src/config.ts`. Key knobs (all env-overridable):

| Parameter | Env var | Default | Description |
|-----------|---------|---------|-------------|
| `riskPerTrade` | `RISK_PER_TRADE` | 0.0025 (0.25%) | Risk per trade |
| `maxConcurrentPositions` | `MAX_CONCURRENT` | 6 | Max simultaneous positions |
| `defaultLeverage` | `DEFAULT_LEVERAGE` | 5 | Base leverage |
| `maxLeverage` | `MAX_LEVERAGE` | 10 | Leverage cap |
| `maxNotionalPerSymbol` | `MAX_NOTIONAL` | 1,500 | USD hard cap per symbol |
| `maxOpenRisk` | `MAX_OPEN_RISK` | 0.01 (1%) | Portfolio heat cap |
| `defaultSymbols` | `SYMBOLS` | Tier A list | Comma-separated override |
| `paperStatePath` | `PAPER_STATE_PATH` | ./data/paper_state.json | Paper state file |
| `logFilePath` | `LOG_FILE` | ./logs/donchian_breakout.jsonl | Log output path |
| `makerTimeoutMs` | `MAKER_TIMEOUT_MS` | 2000 | Maker wait before cancel and IOC (ms) |
| `iocMaxSlippageBps` | `IOC_MAX_SLIPPAGE_BPS` | 8 | Max slippage for IOC fallback (bps) |
| `iocPriceImprovementBps` | `IOC_PRICE_IMPROVEMENT_BPS` | 0 | Optional improvement for IOC limit price |
| `atrPctMax` | `ATR_PCT_MAX` | 0.02 (2%) | Max ATR% to allow entry (chaos ceiling); 2–3% typical |
| `atrPctMaxSoft` | `ATR_PCT_MAX_SOFT` | same as atrPctMax | Max ATR% when in soft brake |

Static config (edit `src/config.ts`):

```typescript
donchianLength: 20,            // 15–30
bufferBps: 3,                  // 2–8
stopAtrMult: 2.0,              // 1.8–2.5
trailAtrMult: 3.0,             // 2.5–3.5
hardDdThreshold: -0.03,
softDdThreshold: -0.015,
```

### Symbol Universe (Tier A v0)

Default: BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, ADA, SUI, BNB

Override with env var `SYMBOLS=BTC,ETH,SOL` or `universeService.setSymbols([...])`.

## Project Structure

```
src/
├── config.ts                          # All parameters
├── types/index.ts                     # Type definitions
├── indicators/
│   ├── donchian.ts                    # Donchian channel
│   ├── atr.ts                         # ATR (Wilder smoothing)
│   └── adx.ts                         # ADX
├── exchange/
│   ├── exchangeClient.ts              # IExchangeClient interface
│   ├── hyperliquidExchangeClient.ts   # Live Hyperliquid trading
│   ├── paperExchangeClient.ts         # Paper trading with live data
│   └── simExchangeClient.ts           # Sim implementation
├── services/
│   ├── universeService.ts             # Tradable symbol management
│   ├── riskService.ts                 # Daily DD, sizing, portfolio heat
│   └── executionService.ts            # Maker/taker, microstructure
├── strategy/
│   └── donchianBreakout15m.ts         # Core strategy engine
├── backtest/
│   ├── simHarness.ts                  # Backtest harness
│   └── simRunner.ts                   # CLI runner with synthetic data
├── runner.ts                          # Live/paper runner with guardrails
├── main.ts                            # Entry point (mode dispatcher)
├── logger.ts                          # JSONL audit logger
└── index.ts                           # Public exports
tests/
├── helpers.ts
├── donchian.test.ts
├── atr.test.ts
├── adx.test.ts
├── breakoutSignal.test.ts
├── trailingStop.test.ts
├── utcDayBoundary.test.ts
├── cooldown.test.ts
├── executionService.test.ts
├── simHarness.test.ts
├── runner.test.ts
└── killSwitch.test.ts
scripts/
├── smoke-order.ts       # npm run smoke — connectivity + order test
├── kill-switch-drill.ts # npm run drill:kill — offline kill-switch drill
└── log-stats.ts         # npm run logs — log analysis dashboard
```

## Logging

Every event emits structured JSON to `./logs/donchian_breakout.jsonl`:

```json
{
  "timestamp": "2025-01-15T14:30:00.000Z",
  "symbol": "BTC",
  "side": "long",
  "module": "DONCHIAN_15M_CLOSE",
  "event": "POSITION_OPENED",
  "executionPath": "MAKER_FILLED",
  "signalParams": { "N": 20, "bufferBps": 3, "atrPct": 0.0067, "adx": 34.2, "candleRangeAtr": 1.3 },
  "riskSnapshot": { "equity": 10000, "ddUtc": -0.005, "riskPerTrade": 0.0025, "sizeMult": 1 }
}
```

### Log modules

| Module | Events |
|--------|--------|
| `DONCHIAN_15M_CLOSE` | Strategy signals, entries, exits, filter skips |
| `EXCHANGE` | `ORDER_PLACED`, `ORDER_CANCELLED`, `ORDER_FILLED`, `ORDER_FAILED`, `EXCHANGE_API_ERROR`, `ORDER_BLOCKED_MAX_NOTIONAL` (audit-grade order trail in paper/live) |
| `RUNNER` | `LIVE_STARTUP_CHECK`, `RUNNER_STARTED`, `RUNNER_STOPPED`, `TICK_ERROR`, `WAITING_FOR_CANDLE` |
| `RISK` | `KILL_SWITCH_TRIGGERED`, `FLATTEN_ALL` |

### Execution path codes
`MAKER_FILLED` | `MAKER_TIMEOUT_TAKER` | `SKIPPED_BAD_MICROSTRUCTURE` | `SKIPPED_NO_FILL` | `SKIPPED_FILTERS`

### Exit reason codes
`STOP_INITIAL` | `TRAIL` | `DAILY_KILL_SWITCH` | `MANUAL` | `EXCHANGE_ERROR`

No `UNKNOWN_EXIT` is ever emitted.

## Integrating a Real Exchange Client

The `HyperliquidExchangeClient` is already provided. To use a different exchange, implement `IExchangeClient` from `src/exchange/exchangeClient.ts`:

```typescript
import type { IExchangeClient } from './exchange/exchangeClient';

class MyExchangeClient implements IExchangeClient {
  async getOrderBookTop(symbol: string) { /* ... */ }
  async getMarkPrice(symbol: string) { /* ... */ }
  async placeLimit(symbol, side, price, size, postOnly) { /* ... */ }
  // ... etc
}
```

Then inject it instead of the default client — all strategy logic is exchange-agnostic via DI.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@nktkas/hyperliquid` | Hyperliquid API SDK (info + exchange clients) |
| `viem` | Wallet key management + EIP-712 signing for HL |
| `typescript` | Build |
| `vitest` | Tests |
| `tsx` | Dev runner |
