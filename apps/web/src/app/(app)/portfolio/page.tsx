import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PortfolioHistoryResponse, PortfolioResponse } from '@vantage/contracts';
import { LoadError } from '../../../components/load-error';
import { PortfolioView } from '../../../components/portfolio-view';
import { getWebConfig } from '../../../lib/config';
import { serverGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Portfolio' };

export default async function PortfolioPage() {
  const [portfolio, history] = await Promise.all([
    serverGet('/v1/portfolio', PortfolioResponse),
    serverGet('/v1/portfolio/history', PortfolioHistoryResponse),
  ]);
  if (!portfolio.ok) {
    if (portfolio.kind === 'unauthenticated') redirect('/login?reason=expired');
    return <LoadError failure={portfolio} what="Portfolio" />;
  }
  return (
    <PortfolioView
      initial={portfolio.data}
      history={history.ok ? history.data.snapshots : null}
      pollMs={getWebConfig().portfolioPollMs}
    />
  );
}
