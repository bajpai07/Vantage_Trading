import { ConfigError, loadConfig } from '@vantage/config';
import type { Env } from '@vantage/config';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/**
 * Decides what the process does.
 * - `--check`: validate configuration only (no network, no DB). Returns 0 (ok) or 2 (invalid).
 * - no arguments: returns 'start' (the caller starts the server; invalid config exits 2 there).
 * - anything else: usage error, returns 64.
 */
export function run(argv: readonly string[], env: Env, io: Io): number | 'start' {
  if (argv.length === 0) return 'start';
  if (argv.length === 1 && argv[0] === '--check') {
    try {
      loadConfig(env);
    } catch (e) {
      io.err(e instanceof ConfigError ? e.message : 'Invalid configuration');
      return 2;
    }
    io.out(JSON.stringify({ app: 'api', status: 'config_ok' }));
    return 0;
  }
  io.err('usage: node dist/main.js [--check]');
  return 64;
}
