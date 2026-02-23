import type { TradingMode } from './types/index.js';

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const _widthPctMin = envFloat('WIDTH_PCT_MIN', 0);
const _atrPctMax = envFloat('ATR_PCT_MAX', 0.02); // chaos ceiling: default 2%; set to Infinity or very high to disable

export const CONFIG = {
  // ── Mode ─────────────────────────────────────────────
  mode: (process.env.MODE ?? 'sim') as TradingMode,

  // ── Universe ──────────────────────────────────────────
  defaultSymbols: process.env.SYMBOLS
    ? process.env.SYMBOLS.split(',').map(s => s.trim())
    : [
        'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'ADA', 'SUI', 'BNB',
        'OP', 'ARB', 'LTC', 'BCH', 'DOT', 'APT', 'NEAR', 'ATOM', 'UNI',
        'INJ', 'TIA', 'SEI', 'WIF', 'TRX', 'FIL', 'ETC', 'XLM',
      ],
  universeRefreshHours: 8,
  minSymbols: 10,
  maxSymbols: 40,

  // ── Indicators (15m) ─────────────────────────────────
  donchianLength: 20,           // configurable 15–30
  atrLength: 14,
  adxLength: 14,

  // ── Entry signal ──────────────────────────────────────
  bufferBps: 3,                 // configurable 2–8
  maxBreakoutAtrMult: envFloat('MAX_BREAKOUT_ATR_MULT', Infinity),

  // ── Donchian width filter (optional, off by default) ───
  enableWidthFilter: process.env.ENABLE_WIDTH_FILTER === 'true',
  widthPctMin: _widthPctMin,
  widthPctMinSoft: envFloat('WIDTH_PCT_MIN_SOFT', _widthPctMin),

  // ── Regime filter (normal) ────────────────────────────
  minAtrPct: 0.004,   // 0.40% min; avoid dead chop
  minAdx: 22,
  maxCandleRangeAtr: 2.0,
  atrPctMax: _atrPctMax,
  atrPctMaxSoft: envFloat('ATR_PCT_MAX_SOFT', _atrPctMax),

  // ── Regime filter (soft brake) ────────────────────────
  softBrakeMinAtrPct: 0.0055,
  softBrakeMinAdx: 26,
  softBrakeMaxCandleRangeAtr: 1.7,

  // ── Cooldown ──────────────────────────────────────────
  cooldownBars: 5,

  // ── Stops / exits ─────────────────────────────────────
  stopAtrMult: 2.0,             // configurable 1.8–2.5
  trailAtrMult: 3.0,            // configurable 2.5–3.5
  tpRMultiple: envFloat('TP_R_MULTIPLE', 1.2),

  // ── Sizing / risk (env-overridable for first-24h conservatism) ─
  riskPerTrade: envFloat('RISK_PER_TRADE', 0.0025),
  maxOpenRisk: envFloat('MAX_OPEN_RISK', 0.01),
  maxConcurrentPositions: envInt('MAX_CONCURRENT', 6),
  maxPositionsPerCluster: 2,
  softBrakeSizeMult: 0.5,

  // ── Leverage (env-overridable) ─────────────────────────
  defaultLeverage: envInt('DEFAULT_LEVERAGE', 5),
  maxLeverage: envInt('MAX_LEVERAGE', 10),
  liquidationBufferMult: 2.0,   // liq_dist >= 2.0 * stop_dist
  maintenanceMarginRate: 0.005, // conservative proxy

  // ── Execution (1m guards) ─────────────────────────────
  entryWindowMinutes: 5,
  maxSpreadBps: envInt('MAX_SPREAD_BPS', 15),
  maxSlippageBps: 8,
  maxMinuteRangeAtrMult: 3.0,
  volatilityLookbackMinutes: 3,
  makerTimeoutSeconds: 10,      // legacy; prefer makerTimeoutMs
  makerTimeoutMs: envInt('MAKER_TIMEOUT_MS', 2000),
  makerImproveBps: 1,           // how much to improve top-of-book
  iocMaxSlippageBps: envInt('IOC_MAX_SLIPPAGE_BPS', 8),
  iocPriceImprovementBps: envInt('IOC_PRICE_IMPROVEMENT_BPS', 0),

  // ── Daily DD ──────────────────────────────────────────
  hardDdThreshold: -0.03,       // -3.0%
  softDdThreshold: -0.015,      // -1.5%

  // ── Live / paper safety ───────────────────────────────
  minNotionalPerOrder: envFloat('MIN_NOTIONAL', 12),
  maxNotionalPerSymbol: envFloat('MAX_NOTIONAL', 1_500),
  takerFeeBps: 3.5,             // 0.035% taker fee estimate
  makerFeeBps: 1.0,             // 0.01% maker fee estimate

  // ── Paper trading ─────────────────────────────────────
  paperStatePath: process.env.PAPER_STATE_PATH ?? './data/paper_state.json',
  paperInitialEquity: 10_000,

  // ── Hyperliquid connection ────────────────────────────
  hlBaseUrl: process.env.HL_BASE_URL ?? 'https://api.hyperliquid.xyz',
  hlWalletAddress: process.env.HL_WALLET_ADDRESS ?? '',
  hlPrivateKey: process.env.HL_PRIVATE_KEY ?? '',

  // ── Logging ───────────────────────────────────────────
  logFilePath: process.env.LOG_FILE ?? './logs/donchian_breakout.jsonl',

  // ── Timeframes ────────────────────────────────────────
  signalTimeframeMs: 15 * 60 * 1000,   // 15m
  executionTimeframeMs: 60 * 1000,      // 1m

  // ── Runner ────────────────────────────────────────────
  candleHistoryBars: 100,  // how many 15m candles to fetch for indicator warmup
} as const;

export type Config = typeof CONFIG;
