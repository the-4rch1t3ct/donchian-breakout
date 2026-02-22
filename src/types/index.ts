export type Side = 'long' | 'short';
export type TradingMode = 'sim' | 'paper' | 'live';

export interface Candle {
  timestamp: number;   // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBookTop {
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  spreadBps: number;
  timestamp?: number;  // unix ms, present on live data
}

export interface Position {
  symbol: string;
  side: Side;
  size: number;          // absolute
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface FillResult {
  filled: boolean;
  orderId?: string;
  fillPrice?: number;
  fillSize?: number;
  fees?: number;
  slippageBps?: number;
}

export interface OpenOrder {
  orderId: string;
  symbol: string;
  side: Side;
  price: number;
  size: number;
  postOnly: boolean;
}

export interface IndicatorSnapshot {
  donchianHigh: number;
  donchianLow: number;
  atr: number;
  atrPct: number;
  adx: number;
  widthPct: number;
}

export interface SignalParams {
  N: number;
  bufferBps: number;
  atrPct: number;
  adx: number;
  candleRangeAtr: number;
  widthPct: number;
}

export type ExecutionPath =
  | 'NO_SIGNAL'
  | 'MAKER_FILLED'
  | 'MAKER_TIMEOUT_TAKER'
  | 'SKIPPED_BAD_MICROSTRUCTURE'
  | 'SKIPPED_NO_FILL'
  | 'SKIPPED_FILTERS';

export type ExitReason =
  | 'STOP_INITIAL'
  | 'TRAIL'
  | 'DAILY_KILL_SWITCH'
  | 'MANUAL'
  | 'EXCHANGE_ERROR';

export type LogModule =
  | 'DONCHIAN_15M_CLOSE'
  | 'EXCHANGE'
  | 'RUNNER'
  | 'RISK';

export interface TradeState {
  symbol: string;
  side: Side;
  entryPrice: number;
  entryTime: number;
  size: number;
  leverage: number;
  initialStop: number;
  trailingStop: number;
  atrAtEntry: number;
  riskAmount: number;    // equity * risk_per_trade at entry
  executionPath: ExecutionPath;
}

export interface RiskSnapshot {
  equity: number;
  ddUtc: number;
  riskPerTrade: number;
  sizeMult: number;
  stopDist: number;
  positionSize: number;
  leverage: number;
}

export interface LogEntry {
  timestamp: string;
  symbol: string;
  side: Side | '';
  module: LogModule;
  event: string;
  signalParams?: SignalParams;
  executionPath?: ExecutionPath;
  exitReason?: ExitReason;
  riskSnapshot?: RiskSnapshot;
  slippageBps?: number;
  spreadBps?: number;
  fees?: number;
  realizedR?: number;
  details?: Record<string, unknown>;
}

export interface CooldownEntry {
  symbol: string;
  side: Side;
  stoppedAtBar: number;
}

export interface DailyState {
  utcDayStart: number;           // unix ms of 00:00 UTC
  equityAtDayStart: number;
  hardKillTriggered: boolean;
  softBrakeActive: boolean;
}
