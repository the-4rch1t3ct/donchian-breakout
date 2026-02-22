export const CONFIG = {
  // ── Universe ──────────────────────────────────────────
  defaultSymbols: [
    'BTC', 'ETH', 'SOL', 'DOGE', 'AVAX',
    'LINK', 'ARB', 'OP', 'SUI', 'INJ',
    'WIF', 'PEPE', 'SEI', 'TIA', 'JUP',
  ],
  universeRefreshHours: 8,
  minSymbols: 10,
  maxSymbols: 20,

  // ── Indicators (15m) ─────────────────────────────────
  donchianLength: 20,           // configurable 15–30
  atrLength: 14,
  adxLength: 14,

  // ── Entry signal ──────────────────────────────────────
  bufferBps: 3,                 // configurable 2–8

  // ── Regime filter (normal) ────────────────────────────
  minAtrPct: 0.0045,
  minAdx: 22,
  maxCandleRangeAtr: 2.0,

  // ── Regime filter (soft brake) ────────────────────────
  softBrakeMinAtrPct: 0.0055,
  softBrakeMinAdx: 26,
  softBrakeMaxCandleRangeAtr: 1.7,

  // ── Cooldown ──────────────────────────────────────────
  cooldownBars: 5,

  // ── Stops ─────────────────────────────────────────────
  stopAtrMult: 2.0,             // configurable 1.8–2.5
  trailAtrMult: 3.0,            // configurable 2.5–3.5

  // ── Sizing / risk ────────────────────────────────────
  riskPerTrade: 0.0025,         // 0.25% of equity
  maxOpenRisk: 0.01,            // 1.0% equity
  maxConcurrentPositions: 6,
  maxPositionsPerCluster: 2,
  softBrakeSizeMult: 0.5,

  // ── Leverage ──────────────────────────────────────────
  defaultLeverage: 5,
  maxLeverage: 10,
  liquidationBufferMult: 2.0,   // liq_dist >= 2.0 * stop_dist
  maintenanceMarginRate: 0.005, // conservative proxy

  // ── Execution (1m guards) ─────────────────────────────
  entryWindowMinutes: 5,
  maxSpreadBps: 10,
  maxSlippageBps: 8,
  maxMinuteRangeAtrMult: 3.0,
  volatilityLookbackMinutes: 3,
  makerTimeoutSeconds: 10,
  makerImproveBps: 1,           // how much to improve top-of-book

  // ── Daily DD ──────────────────────────────────────────
  hardDdThreshold: -0.03,       // -3.0%
  softDdThreshold: -0.015,      // -1.5%

  // ── Logging ───────────────────────────────────────────
  logFilePath: './logs/donchian_breakout.jsonl',

  // ── Timeframes ────────────────────────────────────────
  signalTimeframeMs: 15 * 60 * 1000,   // 15m
  executionTimeframeMs: 60 * 1000,      // 1m
} as const;

export type Config = typeof CONFIG;
