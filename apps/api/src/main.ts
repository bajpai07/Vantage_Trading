import { ConfigError, loadConfigFromProcess } from '@vantage/config';
import { run } from './run.js';

const io = {
  out: (l: string) => process.stdout.write(`${l}\n`),
  err: (l: string) => process.stderr.write(`${l}\n`),
};

const mode = run(process.argv.slice(2), process.env, io);
if (mode !== 'start') {
  process.exitCode = mode;
} else {
  try {
    const config = loadConfigFromProcess(); // fail fast (exit 2) with the redacted aggregated error
    if (config.marketDataSource === 'PROVIDER') {
      // M3a ships no vendor adapter; say so clearly instead of serving anything (M3b adds one).
      io.err('no provider adapter installed; M3b');
      process.exit(2);
    }
  } catch (e) {
    io.err(e instanceof ConfigError ? e.message : 'Invalid configuration');
    process.exit(2);
  }
  const { startServer } = await import('./bootstrap.js');
  await startServer();
}
