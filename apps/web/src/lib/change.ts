// The day change of a quote, for display (M7b, D-82). Everything here is a decimal STRING from the API: the change and the
// percentage are computed by the server, and this file only puts text together (string operations only: no number
// conversion, no arithmetic, no rounding; ESLint bans Number(), parseInt, parseFloat, Math.* and decimal literals here).
import type { ChangeBasis } from '@vantage/contracts';
import { DASH, direction, formatSigned } from './money';
import type { Direction } from './money';

export interface ChangeInput {
  readonly change?: string | null | undefined;
  readonly changePct?: string | null | undefined;
  readonly changeBasis?: ChangeBasis | null | undefined;
}

export interface ChangeView {
  /** false when the API had no prior data (every field null): the view then shows the dash, never 0. */
  readonly available: boolean;
  /** 'up', 'down' or 'flat' from the sign of the change; 'none' when not available. */
  readonly direction: Direction | 'none';
  /** "+3,364.25", "−3.61", "0.00" (digits as received), or the dash. */
  readonly changeText: string;
  /** "+4.67%", "−1.89%", "0.00%", or the dash. */
  readonly pctText: string;
  /** "+3,364.25 (+4.67%)", or the dash. */
  readonly text: string;
  /** Short label of what the change is measured against: "vs previous close" or "24h"; null when not available. */
  readonly basisLabel: string | null;
  /** A sentence for a tooltip and screen readers. */
  readonly basisTitle: string | null;
}

export const BASIS_LABELS: Readonly<Record<ChangeBasis, string>> = {
  PREV_SESSION_CLOSE: 'vs previous close',
  ROLLING_24H: '24h',
};

export const BASIS_TITLES: Readonly<Record<ChangeBasis, string>> = {
  PREV_SESSION_CLOSE: "Change since the previous regular session's close.",
  ROLLING_24H: 'Change over the last 24 hours.',
};

const NONE: ChangeView = {
  available: false,
  direction: 'none',
  changeText: DASH,
  pctText: DASH,
  text: DASH,
  basisLabel: null,
  basisTitle: null,
};

/** Turns the API's day-change strings into display text. Any missing field means "no prior data": the dash. */
export function changeView(i: ChangeInput): ChangeView {
  const { change, changePct, changeBasis } = i;
  if (change === null || change === undefined || changePct === null || changePct === undefined) {
    return NONE;
  }
  const changeText = formatSigned(change);
  const pctNumber = formatSigned(changePct);
  if (changeText === DASH || pctNumber === DASH) return NONE; // not a decimal: never shown as a number
  const pctText = `${pctNumber}%`;
  return {
    available: true,
    direction: direction(change),
    changeText,
    pctText,
    text: `${changeText} (${pctText})`,
    basisLabel:
      changeBasis === null || changeBasis === undefined ? null : BASIS_LABELS[changeBasis],
    basisTitle:
      changeBasis === null || changeBasis === undefined ? null : BASIS_TITLES[changeBasis],
  };
}
