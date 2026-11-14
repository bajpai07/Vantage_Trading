// Exchange calendars: sessions, holidays and early closes in an IANA time zone. Never fixed UTC offsets.
// Built on Intl (the platform's IANA tz database); no extra library. Time is always an argument.
import { z } from 'zod';

const HHMM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be HH:MM (24h)');

const isoDate = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'is not a real calendar date');

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const CalendarSchema = z
  .strictObject({
    version: z.literal(1),
    timezone: z.string().refine(isTimeZone, 'must be an IANA time zone'),
    regular: z.strictObject({
      open: HHMM,
      close: HHMM,
      /** JavaScript weekday numbers: 0 = Sunday ... 6 = Saturday. */
      days: z.array(z.number().int().min(0).max(6)).min(1),
    }),
    holidays: z.array(z.strictObject({ date: isoDate, name: z.string().min(1) })),
    earlyCloses: z.array(z.strictObject({ date: isoDate, close: HHMM, name: z.string().min(1) })),
    /**
     * M7a: a market that never closes (crypto). The market is OPEN at every instant (the session fields are
     * ignored and coverage is not checked). Absent or false: the regular schedule applies.
     */
    alwaysOpen: z.boolean().optional(),
    /** The dates this data is complete for. Outside it the market state is unknown, never guessed. */
    coverage: z.strictObject({ from: isoDate, to: isoDate }),
  })
  .superRefine((cal, ctx) => {
    const bad = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (cal.regular.close <= cal.regular.open) bad('regular.close must be after regular.open');
    if (cal.coverage.to < cal.coverage.from) bad('coverage.to must not be before coverage.from');
    const seen = new Set<string>();
    for (const h of cal.holidays) {
      if (seen.has(h.date)) bad(`duplicate holiday date ${h.date}`);
      seen.add(h.date);
      if (h.date < cal.coverage.from || h.date > cal.coverage.to)
        bad(`holiday ${h.date} is outside coverage`);
    }
    for (const e of cal.earlyCloses) {
      if (e.close <= cal.regular.open || e.close >= cal.regular.close) {
        bad(`early close ${e.date} must be between the regular open and close`);
      }
      if (seen.has(e.date)) bad(`early close ${e.date} is also a holiday`);
      if (e.date < cal.coverage.from || e.date > cal.coverage.to)
        bad(`early close ${e.date} is outside coverage`);
    }
  });

export type Calendar = z.output<typeof CalendarSchema>;

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarError';
  }
}

/** Parses and validates calendar JSON (D-47). The error names the paths and rules. */
export function parseCalendar(json: unknown): Calendar {
  const r = CalendarSchema.safeParse(json);
  if (r.success) return r.data;
  const detail = r.error.issues
    .map((i) => `${i.path.join('.') || 'calendar'}: ${i.message}`)
    .join('; ');
  throw new CalendarError(`invalid calendar: ${detail}`);
}

export type MarketStateName = 'OPEN' | 'CLOSED';
export type SessionKind = 'REGULAR' | 'EARLY_CLOSE';
export type ClosedReason =
  'WEEKEND' | 'HOLIDAY' | 'BEFORE_OPEN' | 'AFTER_CLOSE' | 'CALENDAR_NOT_COVERED';

export interface MarketState {
  readonly state: MarketStateName;
  /** The current session when OPEN; null when closed. */
  readonly session: SessionKind | null;
  /** Why the market is closed; null when OPEN. */
  readonly reason: ClosedReason | null;
  /** Holiday or early-close name when relevant. */
  readonly note: string | null;
  /** Local calendar date (YYYY-MM-DD) of the instant in the exchange time zone. */
  readonly localDate: string;
  /** The next session open strictly after the instant (null if unknown or beyond coverage). */
  readonly nextOpen: Date | null;
  /** The next session close after the instant (null if unknown or beyond coverage). */
  readonly nextClose: Date | null;
}

// ---- time zone arithmetic ----------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Local {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly hh: number;
  readonly mm: number;
  readonly ss: number;
}

function localParts(tz: string, utcMs: number): Local {
  const get: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') get[p.type] = parseInt(p.value, 10);
  }
  return {
    y: get['year'] ?? 0,
    m: get['month'] ?? 0,
    d: get['day'] ?? 0,
    hh: get['hour'] ?? 0,
    mm: get['minute'] ?? 0,
    ss: get['second'] ?? 0,
  };
}

/** Offset of the zone from UTC at an instant, in ms (negative west of Greenwich). */
function offsetMs(tz: string, utcMs: number): number {
  const whole = utcMs - (((utcMs % 1000) + 1000) % 1000);
  const p = localParts(tz, whole);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - whole;
}

/** The UTC instant at which the wall clock in `tz` reads the given local date and time. */
function zonedToUtcMs(tz: string, date: string, hhmm: string): number {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map((p) => parseInt(p, 10)) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const once = guess - offsetMs(tz, guess);
  return guess - offsetMs(tz, once); // second pass settles instants next to a DST change
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function localDateOf(tz: string, utcMs: number): string {
  const p = localParts(tz, utcMs);
  return `${String(p.y).padStart(4, '0')}-${pad2(p.m)}-${pad2(p.d)}`;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ---- sessions ------------------------------------------------------------------------------------

type DayPlan =
  | { readonly kind: 'NOT_COVERED' }
  | { readonly kind: 'NONE'; readonly reason: 'WEEKEND' | 'HOLIDAY'; readonly note: string | null }
  | {
      readonly kind: 'SESSION';
      readonly session: SessionKind;
      readonly open: string;
      readonly close: string;
      readonly note: string | null;
    };

function planFor(cal: Calendar, date: string): DayPlan {
  if (date < cal.coverage.from || date > cal.coverage.to) return { kind: 'NOT_COVERED' };
  const holiday = cal.holidays.find((h) => h.date === date);
  if (holiday !== undefined) return { kind: 'NONE', reason: 'HOLIDAY', note: holiday.name };
  if (!cal.regular.days.includes(weekdayOf(date)))
    return { kind: 'NONE', reason: 'WEEKEND', note: null };
  const early = cal.earlyCloses.find((e) => e.date === date);
  if (early !== undefined) {
    return {
      kind: 'SESSION',
      session: 'EARLY_CLOSE',
      open: cal.regular.open,
      close: early.close,
      note: early.name,
    };
  }
  return {
    kind: 'SESSION',
    session: 'REGULAR',
    open: cal.regular.open,
    close: cal.regular.close,
    note: null,
  };
}

const SEARCH_DAYS = 21; // longer than any run of closed days in a real calendar

/** The first session on a local date after `afterDate`, as UTC instants; null if beyond coverage. */
function nextSession(cal: Calendar, afterDate: string): { open: Date; close: Date } | null {
  let date = afterDate;
  for (let i = 0; i < SEARCH_DAYS; i += 1) {
    date = addDays(date, 1);
    const plan = planFor(cal, date);
    if (plan.kind === 'NOT_COVERED') return null;
    if (plan.kind === 'SESSION') {
      return {
        open: new Date(zonedToUtcMs(cal.timezone, date, plan.open)),
        close: new Date(zonedToUtcMs(cal.timezone, date, plan.close)),
      };
    }
  }
  return null;
}

/** Is the market open at this instant, and when are the next open and close? */
export function marketState(calendar: Calendar, instant: Date): MarketState {
  const tz = calendar.timezone;
  const ms = instant.getTime();
  const localDate = localDateOf(tz, ms);
  if (calendar.alwaysOpen === true) {
    return {
      localDate,
      state: 'OPEN',
      session: 'REGULAR',
      reason: null,
      note: 'Open 24/7',
      nextOpen: null,
      nextClose: null,
    };
  }
  const plan = planFor(calendar, localDate);
  const base = { localDate };

  if (plan.kind === 'NOT_COVERED') {
    return {
      ...base,
      state: 'CLOSED',
      session: null,
      reason: 'CALENDAR_NOT_COVERED',
      note: null,
      nextOpen: null,
      nextClose: null,
    };
  }
  const later = nextSession(calendar, localDate);
  if (plan.kind === 'NONE') {
    return {
      ...base,
      state: 'CLOSED',
      session: null,
      reason: plan.reason,
      note: plan.note,
      nextOpen: later?.open ?? null,
      nextClose: later?.close ?? null,
    };
  }
  const open = zonedToUtcMs(tz, localDate, plan.open);
  const close = zonedToUtcMs(tz, localDate, plan.close);
  if (ms < open) {
    return {
      ...base,
      state: 'CLOSED',
      session: null,
      reason: 'BEFORE_OPEN',
      note: plan.note,
      nextOpen: new Date(open),
      nextClose: new Date(close),
    };
  }
  if (ms >= close) {
    return {
      ...base,
      state: 'CLOSED',
      session: null,
      reason: 'AFTER_CLOSE',
      note: plan.note,
      nextOpen: later?.open ?? null,
      nextClose: later?.close ?? null,
    };
  }
  return {
    ...base,
    state: 'OPEN',
    session: plan.session,
    reason: null,
    note: plan.note,
    nextOpen: later?.open ?? null,
    nextClose: new Date(close),
  };
}

// ---- sessions in a date range (M5: the equity snapshot job) -----------------------------------------------

export interface TradingSession {
  /** The exchange-local trading date (YYYY-MM-DD). */
  readonly date: string;
  readonly open: Date;
  readonly close: Date;
  readonly kind: SessionKind;
  /** Early-close name when relevant. */
  readonly note: string | null;
}

/** The longest date range `sessionsBetween` accepts (a guard against an accidental unbounded loop). */
export const MAX_SESSION_RANGE_DAYS = 800;

/** The exchange-local calendar date of an instant. */
export function exchangeDate(calendar: Calendar, instant: Date): string {
  return localDateOf(calendar.timezone, instant.getTime());
}

/** The date after `date` (both YYYY-MM-DD). */
export function nextDate(date: string): string {
  return addDays(date, 1);
}

/**
 * The trading sessions on the local dates from `fromDate` to `toDate` inclusive, oldest first, with early closes
 * applied. Weekends, holidays and dates outside the calendar's coverage have no session (the calendar is never
 * guessed outside its coverage).
 */
export function sessionsBetween(
  calendar: Calendar,
  fromDate: string,
  toDate: string,
): TradingSession[] {
  const out: TradingSession[] = [];
  let date = fromDate;
  for (let i = 0; date <= toDate; i += 1) {
    if (i > MAX_SESSION_RANGE_DAYS) throw new CalendarError('session range is too long');
    const plan = planFor(calendar, date);
    if (plan.kind === 'SESSION') {
      out.push({
        date,
        open: new Date(zonedToUtcMs(calendar.timezone, date, plan.open)),
        close: new Date(zonedToUtcMs(calendar.timezone, date, plan.close)),
        kind: plan.session,
        note: plan.note,
      });
    }
    date = addDays(date, 1);
  }
  return out;
}
