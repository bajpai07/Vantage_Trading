import { run } from './run.js';

process.exitCode = run(process.argv.slice(2), process.env, {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
});
