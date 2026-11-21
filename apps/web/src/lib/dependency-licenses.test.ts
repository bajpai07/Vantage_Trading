// M10 T0b / D-116: every production dependency licence is permissive, or one of the three the founder accepted.
import { describe, expect, it } from 'vitest';
import { DEPENDENCY_LICENSES, FONT_NOTICES } from './dependency-licenses';

const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
]);
const ACCEPTED = new Set(['OFL-1.1', 'CC-BY-4.0', 'Apache-2.0 AND LGPL-3.0-or-later']);

describe('production dependency licences', () => {
  it('lists the packages and every licence is permissive or an accepted one', () => {
    expect(DEPENDENCY_LICENSES.length).toBeGreaterThan(100);
    const bad = DEPENDENCY_LICENSES.filter(
      (d) => !PERMISSIVE.has(d.license) && !ACCEPTED.has(d.license),
    );
    expect(bad).toEqual([]);
  });
  it('control: the check does reject an unknown licence', () => {
    expect(PERMISSIVE.has('GPL-3.0-only') || ACCEPTED.has('GPL-3.0-only')).toBe(false);
  });
  it('the accepted licences are exactly the three packages of D-116', () => {
    const accepted = DEPENDENCY_LICENSES.filter((d) => ACCEPTED.has(d.license)).map((d) => d.name);
    expect(accepted.sort()).toEqual([
      '@fontsource-variable/inter',
      '@fontsource-variable/jetbrains-mono',
      '@img/sharp-win32-x64',
      'caniuse-lite',
    ]);
  });
  it('the font notices are the verbatim copyright lines', () => {
    expect(FONT_NOTICES.join('\n')).toContain('The Inter Project Authors');
    expect(FONT_NOTICES.join('\n')).toContain('The JetBrains Mono Project Authors');
  });
});
