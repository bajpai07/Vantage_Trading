import { ConfigError, loadConfig } from '@vantage/config';
import type { Env } from '@vantage/config';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Returns the process exit code. 0 = config ok, 2 = invalid config, 64 = skeleton (no flag). */
export function run(argv: readonly string[], env: Env, io: Io): number {
  if (argv.includes('--check')) {
    try {
      loadConfig(env);
    } catch (e) {
      io.err(e instanceof ConfigError ? e.message : 'Invalid configuration');
      return 2;
    }
    io.out(JSON.stringify({ app: 'api', status: 'config_ok' }));
    return 0;
  }
  io.err('vantage api is a skeleton in M0: use --check to validate configuration.');
  return 64;
}
