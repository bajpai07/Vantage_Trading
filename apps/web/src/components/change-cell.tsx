import { changeView } from '../lib/change';
import type { ChangeInput } from '../lib/change';

const STYLE = {
  up: { text: 'text-up', glyph: '▲', word: 'up' },
  down: { text: 'text-down', glyph: '▼', word: 'down' },
  flat: { text: 'text-text-1', glyph: '', word: 'unchanged' },
  none: { text: 'text-text-2', glyph: '', word: 'not available' },
} as const;

/**
 * The day change of a quote, exactly as the API computed it: sign, a ▲ or ▼ glyph and a screen-reader word always
 * accompany the colour (never colour alone). No prior data shows the dash, never 0. `compact` shows only the percentage
 * (search results). The basis ("vs previous close" or "24h") is the visible label and the tooltip.
 */
export function ChangeCell(props: ChangeInput & { compact?: boolean; testId?: string }) {
  const v = changeView(props);
  const s = STYLE[v.direction];
  // compact (search results, shown on the highlighted row) uses the neutral text colour: the sign and the arrow carry the
  // direction, and the red and green tokens do not have enough contrast on that background (axe)
  const colour = props.compact === true && v.direction !== 'none' ? 'text-text-0' : s.text;
  return (
    <span
      className={`num ${colour}`}
      data-testid={props.testId}
      data-direction={v.direction}
      title={v.basisTitle ?? undefined}
    >
      {s.glyph === '' ? null : <span aria-hidden="true">{s.glyph} </span>}
      {props.compact === true ? v.pctText : v.text}
      <span className="sr-only">
        {' '}
        ({s.word}
        {v.basisLabel === null ? '' : `, ${v.basisLabel}`})
      </span>
    </span>
  );
}
