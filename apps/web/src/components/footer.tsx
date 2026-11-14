import type { FeedInfoResponse } from '@vantage/contracts';

/**
 * Shown on every page: this is a simulator, not a brokerage (PRD, ARCHITECTURE section 8). In demo mode (D-77, from the
 * API) it also says that the prices are simulated and the money is virtual.
 */
export function Footer({ feed }: { feed?: FeedInfoResponse | null }) {
  const demo = feed?.demoMode === true;
  return (
    <footer
      data-testid="virtual-money-notice"
      className="mt-auto border-t border-line bg-bg-1 px-4 pb-16 pt-3 text-center text-[12px] text-text-2 md:pb-3"
    >
      Virtual money — not real trading. VANTAGE is a simulator, not a brokerage.
      {demo ? (
        <span data-testid="demo-footer">
          {' '}
          This is a demo: prices are simulated and nothing here is real.
        </span>
      ) : null}
    </footer>
  );
}
