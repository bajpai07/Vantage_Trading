import { PortfolioResponse } from '@vantage/contracts';
import { BfcacheGuard } from '../../components/bfcache-guard';
import { TerminalChrome } from '../../components/terminal-chrome';
import { getWebConfig } from '../../lib/config';
import { requireSession, serverGet } from '../../lib/server-api';

/**
 * The trading terminal group (M9a): the instrument page, full width. Private like (app): the session is checked on the server
 * for every request (D-66). The first Equity comes from the server; the header then refreshes it with ONE poll.
 */
export default async function TerminalLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();
  const portfolio = await serverGet('/v1/portfolio', PortfolioResponse);
  return (
    <>
      <BfcacheGuard />
      <TerminalChrome
        initialPortfolio={portfolio.ok ? portfolio.data : null}
        pollMs={getWebConfig().portfolioPollMs}
        displayName={me.displayName}
      >
        {children}
      </TerminalChrome>
    </>
  );
}
