// The simulated price model (D-78). PURE: a function of (seed, symbol, time) and nothing else, so the price at a given
// instant is the same on every machine and every run, without having to run continuously. No clock, no randomness, no
// IO, no floats: only integer arithmetic (32-bit hashing, safe integers, BigInt for exp). Prices come out as decimal
// strings on the instrument's tick grid.
//
// Model. The log-price offset L(t) is a sum of "value noise" octaves. Octave k has a random value at every multiple of
// 2^k seconds (a hash of seed, symbol, k and the knot index) and is interpolated linearly between knots; its amplitude
// grows with sqrt(2^k), so over any horizon the wandering scales like a random walk would (a Brownian-like process,
// bounded over weeks). price(t) = base x exp(L(t)), rounded to the tick. The daily volatility parameter sets the scale of
// the octaves; it is an illustration parameter, not a calibrated market estimate. In NYSE session mode a small
// overnight gap is added at a fixed time of day (never more than `gapBps` either way).

export interface SimSymbolConfig {
  readonly symbol: string;
  /** Illustrative starting level as a decimal string; the walk moves around it. */
  readonly basePrice: string;
  /** Decimal places of the tick size (tick = 10^-tickDp), for example 2 for 0.01. */
  readonly tickDp: number;
  /** Daily volatility in basis points (150 = 1.5% per day). A scale parameter, not an estimate. */
  readonly dailyVolBps: number;
  /** The usual spread in ticks (1 to 3). */
  readonly baseSpreadTicks: number;
  /** Largest overnight gap in basis points (0 for markets that never close). Only used when gaps are on. */
  readonly gapBps: number;
}

export interface SimQuoteOut {
  /** Both bid and ask are multiples of the tick; bid is always below ask. */
  readonly bid: string;
  readonly ask: string;
  readonly last: string;
}

export interface SimOptions {
  /** Add the overnight gap (NYSE session mode). */
  readonly gaps: boolean;
}

// ---- integer hashing (32-bit, murmur3 finalizer) -------------------------------------------------------------------

/** 32-bit multiply without Math.imul (which the determinism guard bans). */
function imul(a: number, b: number): number {
  const ah = (a >>> 16) & 0xffff;
  const al = a & 0xffff;
  const bh = (b >>> 16) & 0xffff;
  const bl = b & 0xffff;
  return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
}

/** Mixes one 32-bit word into a running hash. */
function mix(h: number, x: number): number {
  let k = imul(x | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = imul(k, 0x1b873593);
  let r = (h ^ k) | 0;
  r = (r << 13) | (r >>> 19);
  r = (imul(r, 5) + 0xe6546b64) | 0;
  return r;
}

function finish(h: number): number {
  let r = h ^ 4;
  r ^= r >>> 16;
  r = imul(r, 0x85ebca6b);
  r ^= r >>> 13;
  r = imul(r, 0xc2b2ae35);
  r ^= r >>> 16;
  return r >>> 0;
}

/** 32-bit FNV-1a of a string (seed and symbol). */
export function hashText(text: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < text.length; i += 1) {
    h = imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/** A hash of four integers, as an unsigned 32-bit number. `c` may be large: its low and high words are both used. */
export function hash4(a: number, b: number, c: number, d: number): number {
  const lo = c % 4294967296;
  const hi = Math.floor(c / 4294967296);
  return finish(mix(mix(mix(mix(mix(0, a), b), lo), hi), d));
}

/** The running hash after mixing the seed and the symbol: the common prefix of every knot hash (computed once per call). */
function knotPrefix(seedH: number, symH: number): number {
  return mix(mix(0, seedH), symH);
}

/**
 * A pseudo-random integer in [-1000000, 1000000] (units of 1e-6) for a knot. Exactly
 * hash4(seedH, symH, index, octave) % 2000001 - 1000000, with the seed and symbol mixes taken out of the loop.
 */
function knot(prefix: number, octave: number, index: number): number {
  const lo = index % 4294967296;
  const hi = Math.floor(index / 4294967296);
  return (finish(mix(mix(mix(prefix, lo), hi), octave)) % 2000001) - 1000000;
}

// ---- octaves ---------------------------------------------------------------------------------------------------------

export const OCTAVES = 23; // knot spacings 1 s, 2 s, 4 s ... 2^22 s (about 48 days)
const DAY_SECONDS = 86400;
/** The overnight gap happens at 14:30 UTC: the NYSE open in winter time (illustrative; not DST-aware on purpose). */
export const GAP_AT_UTC_SECONDS = 52200;

const POW2: number[] = [];
{
  let p = 1;
  for (let i = 0; i <= OCTAVES; i += 1) {
    POW2.push(p);
    p *= 2;
  }
}

/** floor(sqrt(2^k) x 1000): 1000 x 2^(k/2) with the odd powers using 1414.213 (the square root of two). */
const ROOT_POW2_MILLI: number[] = POW2.map((_, k) =>
  k % 2 === 0
    ? 1000 * (POW2[k / 2] as number)
    : Math.floor(((POW2[(k - 1) / 2] as number) * 1414213) / 1000),
);

/** Volatility per square-root second in parts per billion, from the daily figure in basis points. */
function sigmaPpb(dailyVolBps: number): number {
  // 1 bp = 100000 ppb; divide by sqrt(86400) (about 293.94): multiply by 340.2 = 3402 / 10
  return Math.floor((dailyVolBps * 3402) / 10);
}

/** Log-price offset in parts per billion at epoch second `t` (an integer). */
export function logOffsetPpb(
  seed: string,
  cfg: SimSymbolConfig,
  t: number,
  options: SimOptions,
): number {
  const seedH = hashText(seed);
  const symH = hashText(cfg.symbol);
  const sigma = sigmaPpb(cfg.dailyVolBps);
  const prefix = knotPrefix(seedH, symH);
  let total = 0;
  for (let k = 0; k < OCTAVES; k += 1) {
    const span = POW2[k] as number;
    const j = Math.floor(t / span);
    const f = t - j * span; // seconds into the knot interval, 0 to span - 1
    const r0 = knot(prefix, k, j);
    const r1 = knot(prefix, k, j + 1);
    const v = Math.trunc((r0 * (span - f) + r1 * f) / span); // units of 1e-6
    const amp = Math.floor((sigma * (ROOT_POW2_MILLI[k] as number)) / 1000); // ppb
    total += Math.trunc((amp * v) / 1000000);
  }
  if (options.gaps && cfg.gapBps > 0) {
    const day = Math.floor((t - GAP_AT_UTC_SECONDS) / DAY_SECONDS);
    const h = hash4(seedH, symH, day, 4242);
    // a gap on about one day in three; otherwise the level carries on
    if (h % 3 === 0) {
      const u = (Math.floor(h / 3) % 2000001) - 1000000;
      total += Math.trunc((cfg.gapBps * 100000 * u) / 1000000);
    }
  }
  return total;
}

// ---- exp in fixed point (BigInt) -------------------------------------------------------------------------------------

const SCALE = 10n ** 18n;

/** exp(x) scaled by 1e18 for |x| up to about 0.7, x given in parts per billion. */
function expScaled18(xPpb: number): bigint {
  const x = BigInt(xPpb) * 10n ** 9n; // scaled by 1e18
  let term = SCALE;
  let sum = SCALE;
  for (let n = 1n; n <= 14n; n += 1n) {
    term = (term * x) / (SCALE * n);
    sum += term;
  }
  return sum;
}

/** exp(x) for |x| up to about 0.7, x given in parts per billion; returns a decimal string with 12 decimals. */
export function expPpbToString(xPpb: number): string {
  const sum = expScaled18(xPpb);
  const whole = sum / SCALE;
  const frac = (sum % SCALE).toString().padStart(18, '0').slice(0, 12);
  return `${whole.toString()}.${frac}`;
}

const TWELVE = 10n ** 12n;

/** The base price of a symbol as an integer number of ticks (basePrice x 10^tickDp). */
export function baseUnits(cfg: SimSymbolConfig): bigint {
  const [whole = '0', frac = ''] = cfg.basePrice.split('.');
  return BigInt(whole + frac.padEnd(cfg.tickDp, '0').slice(0, cfg.tickDp));
}

/** An integer number of ticks as a decimal string with exactly `dp` decimal places. */
export function unitsToString(units: bigint, dp: number): string {
  if (dp <= 0) return units.toString();
  const digits = units.toString().padStart(dp + 1, '0');
  return `${digits.slice(0, digits.length - dp)}.${digits.slice(digits.length - dp)}`;
}

/**
 * The simulated mid price at epoch second `t` as an INTEGER NUMBER OF TICKS (exact, so prices compare and aggregate
 * without any decimal arithmetic). Equal to round-half-even(basePrice x ratio) where ratio is exp(offset) truncated to
 * 12 decimals; simMid is this value as a string.
 */
export function simMidUnits(
  seed: string,
  cfg: SimSymbolConfig,
  t: number,
  options: SimOptions,
): bigint {
  const ratio12 = expScaled18(logOffsetPpb(seed, cfg, t, options)) / 10n ** 6n; // 12 decimals, truncated
  const n = baseUnits(cfg) * ratio12;
  const q = n / TWELVE;
  const r2 = (n % TWELVE) * 2n;
  if (r2 > TWELVE) return q + 1n;
  if (r2 === TWELVE) return q % 2n === 0n ? q : q + 1n; // half-even
  return q;
}

/** Tick size as a decimal string for a number of decimal places. */
export function tickString(dp: number): string {
  return dp <= 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`;
}

/** The simulated mid price on the tick grid at epoch second `t`. */
export function simMid(seed: string, cfg: SimSymbolConfig, t: number, options: SimOptions): string {
  return unitsToString(simMidUnits(seed, cfg, t, options), cfg.tickDp);
}

/**
 * The simulated quote at epoch second `t` (a whole number of seconds since 1970-01-01T00:00:00Z). `last` is the mid;
 * the spread is 1 to 3 ticks: the symbol's usual spread, one tick wider on about one second in four.
 */
export function simQuoteAt(
  seed: string,
  cfg: SimSymbolConfig,
  t: number,
  options: SimOptions,
): SimQuoteOut {
  const mid = simMidUnits(seed, cfg, t, options);
  const widen = hash4(hashText(seed), hashText(cfg.symbol), t, 7) % 4 === 0 ? 1 : 0;
  const spread = Math.min(3, Math.max(1, cfg.baseSpreadTicks + widen));
  const bid = mid - BigInt(Math.floor(spread / 2));
  const ask = bid + BigInt(spread);
  return {
    bid: unitsToString(bid, cfg.tickDp),
    ask: unitsToString(ask, cfg.tickDp),
    last: unitsToString(mid, cfg.tickDp),
  };
}
