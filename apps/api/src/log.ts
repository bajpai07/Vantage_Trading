// Structured JSON logs. No console. Sensitive keys are redacted wherever they appear, so a password,
// cookie or token can never reach a log line even by accident. Never pass request bodies or headers.
import type { LogLevel } from '@vantage/config';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
const SENSITIVE =
  /pass(word)?|secret|token|cookie|authorization|set-cookie|session|hash|credential/i;
const MAX_DEPTH = 4;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogSink = (line: string) => void;

export const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(level: LogLevel, sink: LogSink = stdoutSink): Logger {
  const min = ORDER[level] ?? ORDER['info'] ?? 2;
  const write = (lvl: string, msg: string, fields?: Record<string, unknown>): void => {
    if ((ORDER[lvl] ?? 0) < min) return;
    const safe = fields === undefined ? {} : (redact(fields) as Record<string, unknown>);
    // The fixed keys come last so a caller cannot overwrite them.
    sink(JSON.stringify({ ...safe, level: lvl, time: new Date().toISOString(), msg }));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
