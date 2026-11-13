// Timestamp display, by string manipulation only (no Date, no time zone: server and browser render the same text, and a
// quote time is always shown in UTC so nobody has to guess).
import { DASH } from './money';

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

/** "2026-11-10T14:45:00.000Z" -> "2026-11-10 14:45:00 UTC". Anything else: DASH. */
export function formatUtc(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return DASH;
  const m = ISO.exec(iso);
  return m === null ? DASH : `${m[1] ?? ''} ${m[2] ?? ''} UTC`;
}

/** "2026-11-10T14:45:00.000Z" -> "2026-11-10 14:45 UTC" (compact, for tables). */
export function formatUtcShort(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return DASH;
  const m = ISO.exec(iso);
  return m === null ? DASH : `${m[1] ?? ''} ${(m[2] ?? '').slice(0, 5)} UTC`;
}

/** A short, readable form of an id for display: the last 8 characters. */
export function shortId(id: string): string {
  return id.slice(-8);
}
