// Drops stale test databases (t_ + 12 hex). Tests never touch vantage_dev. Usage: pnpm test:cleanup
import { dropStaleTestDatabases } from '../packages/test-utils/src/index.ts';

const dropped = await dropStaleTestDatabases();
process.stdout.write(`test:cleanup: dropped ${String(dropped.length)} stale test database(s)\n`);
