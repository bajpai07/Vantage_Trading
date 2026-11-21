// Price-change flash (M9a, D-105). Pure string logic: the direction of a change between two decimal STRINGS is decided by comparing
// digits (no number conversion, no arithmetic). A flash lasts at most FLASH_MS and is never used when the user asked for reduced
// motion; the direction is always also shown as an arrow glyph (never colour alone).
export const FLASH_MS = 600;

export type FlashDirection = 'up' | 'down';

const PLAIN = /^-?\d+(\.\d+)?$/;

/** Compares two plain decimal strings ("90010.00" vs "90010.5") digit by digit; null when either is not a plain decimal. */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 | null {
  if (!PLAIN.test(a) || !PLAIN.test(b)) return null;
  const na = a.startsWith('-');
  const nb = b.startsWith('-');
  const [ai = '', af = ''] = (na ? a.slice(1) : a).split('.');
  const [bi = '', bf = ''] = (nb ? b.slice(1) : b).split('.');
  const width = af.length > bf.length ? af.length : bf.length;
  const ka = `${ai.replace(/^0+(?=\d)/, '')}.${af.padEnd(width, '0')}`;
  const kb = `${bi.replace(/^0+(?=\d)/, '')}.${bf.padEnd(width, '0')}`;
  const zero = /^0\.0*$/;
  const za = zero.test(ka);
  const zb = zero.test(kb);
  const sa = za ? 0 : na ? -1 : 1;
  const sb = zb ? 0 : nb ? -1 : 1;
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (sa === 0) return 0;
  const [pi, pf] = ka.split('.') as [string, string];
  const [qi, qf] = kb.split('.') as [string, string];
  let mag: -1 | 0 | 1;
  if (pi.length !== qi.length) mag = pi.length < qi.length ? -1 : 1;
  else if (pi !== qi) mag = pi < qi ? -1 : 1;
  else if (pf !== qf) mag = pf < qf ? -1 : 1;
  else mag = 0;
  return sa === 1 ? mag : mag === 0 ? 0 : mag === 1 ? -1 : 1;
}

/** 'up' or 'down' when the new price differs from the old one, else null (no flash on the first value, or an unchanged one). */
export function flashDirection(
  previous: string | undefined,
  next: string | undefined,
): FlashDirection | null {
  if (previous === undefined || next === undefined) return null;
  const c = compareDecimalStrings(next, previous);
  if (c === null || c === 0) return null;
  return c > 0 ? 'up' : 'down';
}

/** Whether to flash at all: never under reduced motion. */
export function shouldFlash(reducedMotion: boolean, direction: FlashDirection | null): boolean {
  return !reducedMotion && direction !== null;
}
