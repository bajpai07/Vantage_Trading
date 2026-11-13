import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  InstrumentItem,
  ListOrdersResponse,
  MarketStatusResponse,
  PositionsResponse,
  QuotesResponse,
  SymbolSchema,
} from '@vantage/contracts';
import { InstrumentView } from '../../../../components/instrument-view';
import { LoadError } from '../../../../components/load-error';
import { getWebConfig } from '../../../../lib/config';
import { serverGet } from '../../../../lib/server-api';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const s = SymbolSchema.safeParse((await params).symbol);
  return { title: s.success ? s.data : 'Instrument' };
}

export default async function InstrumentPage({ params }: { params: Promise<{ symbol: string }> }) {
  const parsed = SymbolSchema.safeParse((await params).symbol);
  if (!parsed.success) notFound(); // not even a ticker shape: a plain 404
  const symbol = parsed.data;
  const q = encodeURIComponent(symbol);

  const [instrument, quotes, market, positions, orders] = await Promise.all([
    serverGet(`/v1/instruments/${q}`, InstrumentItem),
    serverGet(`/v1/quotes?symbols=${q}`, QuotesResponse),
    serverGet('/v1/market/status', MarketStatusResponse),
    serverGet('/v1/positions', PositionsResponse),
    serverGet(`/v1/orders?symbol=${q}&limit=10`, ListOrdersResponse),
  ]);
  for (const r of [instrument, quotes]) {
    if (!r.ok && r.kind === 'unauthenticated') redirect('/login?reason=expired');
  }
  if (!instrument.ok) {
    if (instrument.kind === 'not_found') notFound(); // an unknown symbol: the 404 page
    return <LoadError failure={instrument} what={symbol} />;
  }
  const quote = quotes.ok ? quotes.data.quotes.find((x) => x.symbol === symbol) : undefined;
  if (quote === undefined)
    return (
      <LoadError
        failure={
          quotes.ok
            ? {
                ok: false,
                kind: 'invalid_response',
                status: 200,
                code: null,
                retryAfterSeconds: null,
                supportCode: null,
                fields: [],
              }
            : quotes
        }
        what={symbol}
      />
    );

  return (
    <InstrumentView
      instrument={instrument.data}
      initialQuote={quote}
      market={market.ok ? market.data : null}
      position={
        positions.ok
          ? (positions.data.positions.find((p) => p.symbol === symbol) ?? null)
          : undefined
      }
      orders={orders.ok ? orders.data.orders : null}
      quotePollMs={getWebConfig().quotePollMs}
    />
  );
}
