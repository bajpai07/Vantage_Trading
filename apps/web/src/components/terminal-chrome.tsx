'use client';

import Link from 'next/link';
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { PortfolioResponse } from '@vantage/contracts';
import { formatMoney } from '../lib/money';
import { usePortfolioPoll } from '../lib/use-portfolio-poll';
import type { PortfolioPoll } from '../lib/use-portfolio-poll';
import { AppNav } from './app-nav';
import { Brand } from './brand';
import { LogoutButton } from './logout-button';
import { SearchBox } from './search-box';

const PortfolioContext = createContext<PortfolioPoll | null>(null);

/** The terminal's single portfolio poll (header Equity, bottom panel positions). */
export function usePortfolio(): PortfolioPoll {
  const p = useContext(PortfolioContext);
  if (p === null) throw new Error('usePortfolio is used outside the terminal chrome');
  return p;
}

function HeaderEquity() {
  const p = usePortfolio();
  return (
    <div className="flex items-center gap-3 text-text-2">
      <span>
        Equity{' '}
        <b data-testid="header-equity" className="num font-semibold text-text-0">
          {p.data === null ? '—' : `$${formatMoney(p.data.equity)}`}
        </b>
        {p.failed ? (
          <span className="ml-1 text-[11px] text-stale" data-testid="header-equity-stale">
            (not refreshed)
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The persistent terminal header (Terminal.dc.html): logo, nav, global search, Equity from the portfolio endpoint. The
 * "SIMULATED MARKET DATA" banner above it comes from the root layout and stays on every page.
 */
export function TerminalChrome(props: {
  initialPortfolio: PortfolioResponse | null;
  pollMs: number;
  displayName: string;
  children: ReactNode;
}) {
  const poll = usePortfolioPoll(props.initialPortfolio, props.pollMs);
  return (
    <PortfolioContext.Provider value={poll}>
      <header className="border-b border-line bg-bg-1 md:sticky md:top-[var(--banner-h)] md:z-20">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 md:min-h-14 md:justify-start lg:px-6">
          <Link
            href="/portfolio"
            aria-label="VANTAGE, go to portfolio"
            className="text-text-0 hover:text-text-0"
          >
            <Brand />
          </Link>
          <AppNav />
          <div className="order-last w-full md:order-none md:ml-auto md:w-auto md:min-w-[260px] md:max-w-[420px] md:flex-1">
            <SearchBox />
          </div>
          <HeaderEquity />
          <div className="flex items-center gap-3">
            <span
              data-testid="user-name"
              className="hidden max-w-40 truncate text-[12px] text-text-2 sm:inline"
            >
              {props.displayName}
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main id="main" className="w-full flex-1 pb-20 md:pb-6">
        {props.children}
      </main>
    </PortfolioContext.Provider>
  );
}
