// pnpm compose:setup (M10, D-110): creates the UNTRACKED .env.compose from .env.compose.example with strong random secrets.
// The secrets are generated with node:crypto and are NEVER printed. It refuses to overwrite an existing file (use --force to
// regenerate; the Postgres volume keeps the old passwords, so run `docker compose down -v` first).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const example = resolve(root, '.env.compose.example');
const target = resolve(root, '.env.compose');
const force = process.argv.includes('--force');
if (process.argv.slice(2).some((a) => a !== '--force')) {
  process.stderr.write('usage: pnpm compose:setup [--force]\n');
  process.exit(64);
}
if (existsSync(target) && !force) {
  process.stderr.write(
    '.env.compose already exists (not overwritten). Use --force to regenerate the secrets.\n',
  );
  process.exit(1);
}
let generated = 0;
const text = readFileSync(example, 'utf8')
  .split('\n')
  .map((line) => {
    const m = /^([A-Z0-9_]*PASSWORD)=change-me\s*$/.exec(line);
    if (m === null) return line;
    generated += 1;
    return `${m[1]}=${randomBytes(24).toString('base64url')}`; // 32 URL-safe characters, never shown
  })
  .join('\n');
if (generated === 0) throw new Error('the example file has no placeholder to replace');
writeFileSync(target, text, { mode: 0o600 });
process.stdout.write(
  `.env.compose written with ${String(generated)} generated secrets (not shown). Next: docker compose --env-file .env.compose up --build\n`,
);
