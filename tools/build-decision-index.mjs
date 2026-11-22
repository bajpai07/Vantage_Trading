// Rewrites the decision index between the markers in docs/FACTS.md from docs/specs/DECISIONS.md, so every D number is listed and the
// index cannot drift (tools/facts.test.ts checks it). Run: node tools/build-decision-index.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rows = readFileSync(resolve(root, 'docs/specs/DECISIONS.md'), 'utf8')
  .split('\n')
  .filter((l) => /^\| D-\d+/.test(l));
const lines = ['| ID | Decision (first phrase of the row) | Status |', '| --- | --- | --- |'];
for (const row of rows) {
  const cells = row.split('|').map((c) => c.trim());
  const id = cells[1];
  const bold = /\*\*(.+?)\*\*/.exec(cells[2]);
  let title = (bold ? bold[1] : cells[2]).replace(/\.$/, '').replace(/\s+/g, ' ');
  if (title.length > 110) title = `${title.slice(0, 107).trimEnd()}...`;
  title = title.replaceAll('|', '/');
  const status = /Status: ([^|]*?)\s*\|?\s*$/.exec(row)?.[1]?.replace(/\.$/, '');
  const superseded = /superseded by (D-\d+)/i.exec(cells[2]);
  lines.push(
    `| ${id} | ${title} | ${
      superseded
        ? `Superseded by ${superseded[1]}`
        : (status ?? 'In force (no status recorded in the row)')
    } |`,
  );
}
const file = resolve(root, 'docs/FACTS.md');
const text = readFileSync(file, 'utf8');
const start = '<!-- decisions:start -->';
const end = '<!-- decisions:end -->';
const a = text.indexOf(start);
const b = text.indexOf(end);
if (a < 0 || b < a) throw new Error('markers missing in docs/FACTS.md');
writeFileSync(
  file,
  `${text.slice(0, a + start.length)}\n\n${lines.join('\n')}\n\n${text.slice(b)}`,
);
process.stdout.write(`${String(rows.length)} decisions indexed\n`);
