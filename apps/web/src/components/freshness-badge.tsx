import { freshnessView } from '../lib/freshness';
import type { FreshnessState } from '../lib/freshness';
import { formatUtc } from '../lib/format';

const TONE: Record<ReturnType<typeof freshnessView>['tone'], { box: string; dot: string }> = {
  up: { box: 'border-up text-up', dot: 'bg-up' },
  warn: { box: 'border-warn text-warn', dot: 'bg-warn' },
  stale: { box: 'border-stale text-stale underline decoration-dotted', dot: 'bg-stale' },
  muted: { box: 'border-line-strong text-text-2', dot: 'bg-text-2' },
  down: { box: 'border-down text-down', dot: 'bg-down' },
};

/**
 * The freshness pill (DESIGN_SYSTEM section 6): a dot and the state in words, always both, so colour is never the
 * only signal. The tooltip says what the state means and, when given, where the quote came from and when.
 */
export function FreshnessBadge(props: {
  state: FreshnessState;
  source?: string | null | undefined;
  asOf?: string | null | undefined;
}) {
  const view = freshnessView(props.state);
  const tone = TONE[view.tone];
  const detail = [
    view.description,
    props.source === null || props.source === undefined ? null : `Source: ${props.source}.`,
    props.asOf === null || props.asOf === undefined
      ? null
      : `Quote time: ${formatUtc(props.asOf)}.`,
  ]
    .filter((x): x is string => x !== null)
    .join(' ');
  return (
    <span
      data-testid="freshness-badge"
      data-state={props.state}
      title={detail}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 text-[11px] font-medium leading-[14px] ${tone.box}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${tone.dot}`} />
      {view.label}
    </span>
  );
}
