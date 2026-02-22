# Donchian Breakout 15m — Hyperliquid Perps

Close-confirmed Donchian channel breakout strategy with strict risk controls, maker-first execution, and audit-grade logging.

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
| ATR% | >= 0.45% | >= 0.55% |
| ADX | >= 22 | >= 26 |
| Candle range / ATR | <= 2.0 | <= 1.7 |

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

### UTC-Day Drawdown Controls

| Threshold | Action |
|-----------|--------|
| DD <= -1.5% | **Soft brake:** size_mult=0.5, tighter filters |
| DD <= -3.0% | **Hard kill:** flatten ALL, cancel ALL, disable entries until next UTC day |

DD = `(current_equity - equity_at_UTC_midnight) / equity_at_UTC_midnight`

## Execution Model

After a 15m signal fires, within a 5-minute entry window:

1. **Microstructure guards** (1m data):
   - Spread <= 10 bps
   - Estimated slippage <= 8 bps
   - No 1m candle in last 3 minutes with `range > 3 * ATR_1m`
2. **Maker limit** slightly improved from top-of-book, 10s timeout
3. **Taker fallback** only if guards still pass after maker timeout

## Configuration

All parameters live in `src/config.ts`. Key knobs:

```typescript
donchianLength: 20,     // 15–30
bufferBps: 3,           // 2–8
stopAtrMult: 2.0,       // 1.8–2.5
trailAtrMult: 3.0,      // 2.5–3.5
riskPerTrade: 0.0025,   // 0.25%
maxConcurrentPositions: 6,
hardDdThreshold: -0.03,
softDdThreshold: -0.015,
```

### Symbol Universe

Default Tier-A list in `config.defaultSymbols`. Override with `universeService.setSymbols(["BTC", "ETH", ...])`.

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
└── simHarness.test.ts
```

## Running

```bash
npm install
npm test              # 45 unit tests
npm run sim           # synthetic backtest
npm run build         # TypeScript compile
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
  "riskSnapshot": { "equity": 10000, "ddUtc": -0.005, "riskPerTrade": 0.0025, "sizeMult": 1, ... },
  "exitReason": null
}
```

### Execution path codes
`MAKER_FILLED` | `MAKER_TIMEOUT_TAKER` | `SKIPPED_BAD_MICROSTRUCTURE` | `SKIPPED_NO_FILL` | `SKIPPED_FILTERS`

### Exit reason codes
`STOP_INITIAL` | `TRAIL` | `DAILY_KILL_SWITCH` | `MANUAL` | `EXCHANGE_ERROR`

No `UNKNOWN_EXIT` is ever emitted.

## Integrating a Real Exchange Client

Implement `IExchangeClient` from `src/exchange/exchangeClient.ts`:

```typescript
import type { IExchangeClient } from './exchange/exchangeClient';

class HyperliquidClient implements IExchangeClient {
  async getOrderBookTop(symbol: string) { /* ... */ }
  async placeLimit(symbol, side, price, size, postOnly) { /* ... */ }
  // ... etc
}
```

Then inject it instead of `SimExchangeClient` — all strategy logic is exchange-agnostic via DI.
