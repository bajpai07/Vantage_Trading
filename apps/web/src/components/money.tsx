import type { ReactNode } from 'react';
import { DASH, direction, formatMoney, formatSigned } from '../lib/money';

/**
 * A money amount exactly as the API sent it (2 dp string), with thousands separators added by string manipulation.
 * `exact` (the full-precision string) is available on hover and in the "Exact amounts" detail; null shows the dash.
 */
export function Money(props: {
  value: string | null | undefined;
  exact?: string | null | undefined;
  signed?: boolean;
  testId?: string | undefined;
}) {
  const { value, exact, signed = false, testId } = props;
  const text = signed ? formatSigned(value) : formatMoney(value);
  const title =
    exact === null || exact === undefined || value === null ? undefined : `Exact: ${exact}`;
  return (
    <span className="num" title={title} data-testid={testId}>
      {text}
      {value === null || value === undefined ? (
        <span className="sr-only">not available</span>
      ) : null}
    </span>
  );
}

const DIRECTION = {
  up: { glyph: '▲', text: 'text-up', word: 'gain' },
  down: { glyph: '▼', text: 'text-down', word: 'loss' },
  flat: { glyph: '', text: 'text-text-1', word: '' },
} as const;

/**
 * A profit or loss: the sign, a ▲ or ▼ glyph and a screen-reader word always accompany the colour (never colour
 * alone). Zero shows no sign and no arrow. null (no value, e.g. an unpriced position) shows the dash.
 */
export function PnlCell(props: {
  value: string | null | undefined;
  exact?: string | null | undefined;
  testId?: string | undefined;
}) {
  const { value, exact, testId } = props;
  if (value === null || value === undefined) {
    return (
      <span className="num text-text-2" data-testid={testId} data-direction="none">
        {DASH}
        <span className="sr-only">not available</span>
      </span>
    );
  }
  const d = direction(value);
  const v = DIRECTION[d];
  return (
    <span
      className={`num ${v.text}`}
      data-testid={testId}
      data-direction={d}
      title={exact === null || exact === undefined ? undefined : `Exact: ${exact}`}
    >
      {v.glyph === '' ? null : <span aria-hidden="true">{v.glyph} </span>}
      {formatSigned(value)}
      {v.word === '' ? null : <span className="sr-only"> ({v.word})</span>}
    </span>
  );
}

/** A compact summary tile: a 12 px label, a 18 px mono value, an optional note. */
export function MetricCard(props: {
  label: string;
  children: ReactNode;
  note?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={props.testId} className="rounded-md border border-line bg-bg-1 px-3 py-2">
      <div className="text-[12px] leading-4 text-text-2">{props.label}</div>
      <div className="num mt-0.5 text-[18px] leading-6 text-text-0">{props.children}</div>
      {props.note === undefined ? null : (
        <div className="mt-0.5 text-[11px] leading-[14px] text-text-2">{props.note}</div>
      )}
    </div>
  );
}
