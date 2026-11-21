// Design-token guards (DESIGN_SYSTEM section 10): raw colours live in tokens.css only, and every text/background pair
// the app uses meets the contrast rule. These tests are about colour values, so they may use floating point.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..');
const repoRoot = join(webRoot, '..', '..');
const tokensCss = readFileSync(join(here, 'tokens.css'), 'utf8');

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss);
  if (m?.[1] === undefined) throw new Error(`token --${name} is not a plain hex colour`);
  return m[1];
}
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// M9a: the palette is the founder's Terminal.dc.html mock. Where it differs from DESIGN_SYSTEM section 2 the mock wins for look
// (recorded with D-103); the contrast and raw-colour rules of DESIGN_SYSTEM still apply and are tested below.
describe('tokens match Terminal.dc.html (M9a) and keep the DESIGN_SYSTEM rules', () => {
  it.each([
    ['bg-0', '#0b0e13'],
    ['bg-1', '#0f131b'],
    ['bg-2', '#121822'],
    ['bg-3', '#1a2332'],
    ['bg-4', '#1e2a44'],
    ['line', '#232c3a'],
    ['line-strong', '#2b3547'],
    ['text-0', '#e8ecf2'],
    ['text-1', '#c3cad6'],
    ['text-2', '#98a2b3'],
    ['text-3', '#667184'],
    ['accent', '#4f7cff'],
    ['accent-hi', '#7da0ff'],
    ['violet', '#8b6cff'],
    ['up', '#3ddc97'],
    ['down', '#ff7a7a'],
    ['warn', '#f5b93b'],
    ['stale', '#e8884a'],
    ['info', '#4bb5e8'],
    ['primary', '#2f5fe3'],
    ['down-text', '#ff9a9a'],
    ['sim-bg', '#f5b93b'],
    ['sim-fg', '#1a1300'],
    ['buy', '#1f6b4d'],
    ['sell', '#a03a47'],
    ['chip-up', '#1b3a2e'],
  ])('--%s is %s', (name, hex) => {
    expect(token(name).toLowerCase()).toBe(hex);
  });
});

describe('contrast (text at least 4.5:1, UI components at least 3:1)', () => {
  const surfaces = ['bg-0', 'bg-1', 'bg-2', 'bg-3'] as const;
  const text = [
    'text-0',
    'text-1',
    'text-2',
    'accent',
    'accent-hi',
    'up',
    'down',
    'down-text',
    'warn',
    'stale',
    'info',
  ] as const;

  // Accent text is not used on bg-3 (hover rows and menus; links there use accent-hi), where it reaches only 4.2:1.
  const pairs = text
    .flatMap((t) => surfaces.map((s) => [t, s] as const))
    .filter(([t, s]) => !(t === 'accent' && s === 'bg-3'));
  it.each(pairs)('%s on %s is at least 4.5:1', (t, s) => {
    expect(contrast(token(t), token(s))).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring (accent) is at least 3:1 against every surface it sits on', () => {
    for (const s of surfaces) expect(contrast(token('accent'), token(s))).toBeGreaterThanOrEqual(3);
  });

  it('control: --text-3 is NOT good enough for essential text on the lighter surfaces, which is why it is never used for it', () => {
    expect(contrast(token('text-3'), token('bg-3'))).toBeLessThan(4.5);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(css|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('raw colours live in tokens.css only', () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b/;
  const RGB = /\brgba?\(|\bhsla?\(/;

  it('no other source file (components, pages, styles, helpers) contains a hex or rgb()/hsl() colour', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(join(webRoot, 'src'))) {
      const rel = relative(webRoot, f).replaceAll('\\', '/');
      if (rel === 'src/styles/tokens.css' || /\.test\.tsx?$/.test(rel)) continue;
      const body = readFileSync(f, 'utf8');
      if (HEX.test(body) || RGB.test(body)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('control: the detector does see a colour where there is one', () => {
    expect(HEX.test(tokensCss)).toBe(true);
    expect(RGB.test(tokensCss)).toBe(true);
  });
});

describe('the lint rule rejects raw hex in components (ESLint, the real config)', () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const lint = async (code: string, file: string) => {
    const [r] = await eslint.lintText(code, { filePath: join(repoRoot, file) });
    return (r?.messages ?? []).filter((m) => m.severity === 2);
  };

  it('flags a hex colour in a string and in a template literal, in a component', async () => {
    expect(
      (await lint('export const a = "#ff0000";', 'apps/web/src/components/x.tsx')).length,
    ).toBeGreaterThan(0);
    expect(
      (await lint('export const a = `bg-[#abc]`;', 'apps/web/src/components/x.tsx')).length,
    ).toBeGreaterThan(0);
  });

  it('allows token classes and variables (control)', async () => {
    const code =
      'export const a = "bg-bg-1 text-text-0"; export const b = "var(--accent)"; export const c = "#main";';
    expect(await lint(code, 'apps/web/src/components/x.tsx')).toEqual([]);
  });
});
