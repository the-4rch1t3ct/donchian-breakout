import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogEntry, LogModule } from './types/index.js';

export class StrategyLogger {
  private filePath: string | null;
  private stream: fs.WriteStream | null = null;
  private buffer: LogEntry[] = [];

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
    if (filePath) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    }
  }

  log(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    this.buffer.push(entry);

    if (this.stream) {
      this.stream.write(line + '\n');
    }

    if (process.env.LOG_STDOUT !== '0') {
      const level = entry.event.startsWith('ERROR') ? 'ERROR' :
                    entry.event.includes('KILL') ? 'WARN' :
                    entry.event.includes('BRAKE') ? 'WARN' : 'INFO';
      console.log(`[${entry.timestamp}] [${level}] [${entry.module}] ${entry.event} ${entry.symbol || ''} ${entry.side || ''}`);
    }
  }

  logSignal(
    symbol: string,
    side: '' | 'long' | 'short',
    event: string,
    extra: Partial<LogEntry> = {},
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      symbol,
      side,
      module: 'DONCHIAN_15M_CLOSE',
      event,
      ...extra,
    });
  }

  logEvent(
    module: LogModule,
    event: string,
    symbol = '',
    side: '' | 'long' | 'short' = '',
    extra: Partial<LogEntry> = {},
  ): void {
    this.log({
      timestamp: new Date().toISOString(),
      symbol,
      side,
      module,
      event,
      ...extra,
    });
  }

  getBuffer(): readonly LogEntry[] {
    return this.buffer;
  }

  clearBuffer(): void {
    this.buffer = [];
  }

  close(): void {
    this.stream?.end();
  }
}
