'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CandleInterval,
  InstrumentItem,
  MarketStatusResponse,
  OrderResponse,
  PositionResponse,
  QuoteItem,
} from '@vantage/contracts';
import { formatUtcShort } from '../lib/format';
import { DASH, formatMoney, formatPrice, formatQty, isZeroDecimal } from '../lib/money';
import { ASSET_CLASS_LABELS, statusView } from '../lib/market';
import { rejectMessage } from '../lib/reject-copy';
import {
  browserStorageOrNull,
  loadShortcutsEnabled,
  resolveShortcut,
  saveShortcutsEnabled,
  stepIndex,
  stepInterval,
} from '../lib/shortcuts';
import { useDepthPoll } from '../lib/use-depth-poll';
import { useIsPhone } from '../lib/use-is-phone';
import { useWatchlist } from '../lib/use-watchlist';
import { useQuotePoll } from '../lib/use-quote-poll';
import type { OrderKind } from '../lib/ticket';
import { BottomPanel } from './bottom-panel';
import { ChartPanel } from './chart-panel';
import { DepthBook } from './depth-book';
import { OrderTicket } from './order-ticket';
import { FullScreenDrawer, PhoneActionBar } from './phone-parts';
import { TicketSheet } from './ticket-sheet';
import { ShortcutsHelp } from './shortcuts-help';
import { QuotePanel } from './quote-panel';
import { usePortfolio } from './terminal-chrome';
import { WatchlistRail, WatchStar } from './watchlist-rail';
import { Alert, EmptyState } from './ui';

/** The status badge of an instrument: a word and a glyph, never colour alone. */
export function StatusBadge({ status }: { status: InstrumentItem['status'] }) {
  const v = statusView(status);
  const tone =
    v.tone === 'ok'
      ? 'border-up text-up'
      : v.tone === 'warn'
        ? 'border-warn text-warn'
        : 'border-down text-down';
  return (
    <span
      data-testid="instrument-status"
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 text-[11px] font-medium leading-[14px] ${tone}`}
    >
      <span aria-hidden="true">{v.tone === 'ok' ? '●' : v.tone === 'warn' ? '▲' : '✕'}</span>
      {v.label}
    </span>
  );
}

function PositionPanel({
  symbol,
  position,
  buyingPower,
}: {
  symbol: string;
  position: PositionResponse | null | undefined;
  /** The free cash, a string from the portfolio endpoint (null when it could not be read). */
  buyingPower: string | null;
}) {
  return (
    <section aria-labelledby="position-title" data-testid="position-panel">
      <h2 id="position-title" className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">
        Your position
      </h2>
      {position === undefined ? (
        <p className="text-[13px] text-text-2" data-testid="position-error">
          Your position is not available right now.
        </p>
      ) : position === null ? (
        <p className="text-[13px] text-text-1" data-testid="position-none">
          You do not hold {symbol}.
        </p>
      ) : (
        <dl className="num grid max-w-xs grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-text-2">Shares</dt>
          <dd className="text-right text-text-0" data-testid="position-qty">
            {formatQty(position.qty)}
          </dd>
          {isZeroDecimal(position.qtyReserved) ? null : (
            <>
              <dt className="text-text-2">Reserved for open orders</dt>
              <dd className="text-right text-text-0" data-testid="position-reserved">
                {formatQty(position.qtyReserved)}
              </dd>
            </>
          )}
          <dt className="text-text-2">Average cost</dt>
          <dd className="text-right text-text-0" data-testid="position-avg-cost">
            {formatPrice(position.avgCost)}
          </dd>
        </dl>
      )}
      <dl className="num mt-3 grid max-w-xs grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line pt-2 text-[13px]">
        <dt className="text-text-2">Buying power</dt>
        <dd className="text-right text-text-0" data-testid="buying-power">
          {buyingPower === null ? DASH : '$' + formatMoney(buyingPower)}
        </dd>
      </dl>
    </section>
  );
}

function RecentOrders({
  symbol,
  orders,
}: {
  symbol: string;
  orders: readonly OrderResponse[] | null;
}) {
  return (
    <section aria-labelledby="recent-title" data-testid="recent-orders">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id="recent-title" className="text-[16px] font-semibold leading-[22px] text-text-0">
          Recent orders in {symbol}
        </h2>
        <Link href="/orders" className="text-[12px]">
          All orders
        </Link>
      </div>
      {orders === null ? (
        <p className="text-[13px] text-text-2">Your recent orders are not available right now.</p>
      ) : orders.length === 0 ? (
        <EmptyState title={`No ${symbol} orders yet`}>
          Orders you place in this instrument appear here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-bg-1">
          {orders.map((o) => (
            <li
              key={o.id}
              data-testid="recent-order"
              data-status={o.status}
              className="px-3 py-2 text-[12px]"
            >
              <span className="num text-text-2">{formatUtcShort(o.createdAt)}</span>{' '}
              <span className={`font-medium ${o.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                <span aria-hidden="true">{o.side === 'BUY' ? '▲ ' : '▼ '}</span>
                {o.side}
              </span>{' '}
              <span className="num text-text-0">{formatQty(o.qty)}</span> ·{' '}
              {o.status === 'FILLED' && o.execution !== null ? (
                <span className="num">
                  <span aria-hidden="true" className="text-up">
                    ✓{' '}
                  </span>
                  Filled @ {formatPrice(o.execution.price)}, fee {formatMoney(o.execution.fee)}
                </span>
              ) : (
                <span>
                  <span aria-hidden="true" className="text-down">
                    ✕{' '}
                  </span>
                  Rejected: {rejectMessage(o.rejectCode)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The trading terminal (M9a, Terminal.dc.html): watchlist rail, chart centre, order ticket and book on the right, positions /
 * open orders / history underneath. The first render comes from the server; the quote then refreshes itself. Layout:
 * >= 1280 px three columns (270 | 1fr | 330); 1024 to 1279 a narrow symbol-only rail, the ticket and the book under the chart;
 * below 1024 one column (the phone layout is M9b: only "no horizontal scroll" is guaranteed there).
 */
export function InstrumentView(props: {
  instrument: InstrumentItem;
  initialQuote: QuoteItem;
  market: MarketStatusResponse | null;
  position: PositionResponse | null | undefined;
  orders: readonly OrderResponse[] | null;
  quotePollMs: number;
  ordersPollMs: number;
}) {
  const { instrument } = props;
  const poll = useQuotePoll(instrument.symbol, props.initialQuote, props.quotePollMs);
  const isPhone = useIsPhone();
  // the phone book starts with 8 levels ("Show more" asks for 15, then 25); a wider screen uses the API default
  const [phoneLevels, setPhoneLevels] = useState(8);
  const depth = useDepthPoll(
    instrument.symbol,
    props.quotePollMs,
    isPhone === true ? phoneLevels : undefined,
  );
  const watchlist = useWatchlist();
  const portfolio = usePortfolio();
  const [ticketKind, setTicketKind] = useState<OrderKind>('MARKET');
  const [interval, setInterval] = useState<CandleInterval>('15m');
  const [sideCmd, setSideCmd] = useState<{ side: 'BUY' | 'SELL'; seq: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [kindCmd, setKindCmd] = useState<{ kind: OrderKind; seq: number } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reopen, setReopen] = useState(0);
  const [watchOpen, setWatchOpen] = useState(false);
  const [ticketPhase, setTicketPhase] = useState<{ phase: string; outcome: string | null }>({
    phase: 'idle',
    outcome: null,
  });
  const opener = useRef<HTMLElement | null>(null);
  const wasDone = useRef(false);
  const [ordersRefresh, setOrdersRefresh] = useState(0);
  const [shortcutsOn, setShortcutsOn] = useState(true);
  const [pick, setPick] = useState<{ price: string; seq: number } | null>(null);
  const sv = statusView(instrument.status);

  // the phone sheet: it cannot be closed while an order is being sent; after the result is closed it closes too
  const locked = ticketPhase.phase === 'submitting';
  const closeSheet = useCallback((): void => {
    setSheetOpen(false);
    const el = opener.current;
    if (el !== null) setTimeout(() => el.focus(), 0); // focus returns to the control that opened the sheet
  }, []);
  useEffect(() => {
    if (ticketPhase.phase === 'done') wasDone.current = true;
    else if (ticketPhase.phase === 'idle' && wasDone.current) {
      wasDone.current = false;
      if (sheetOpen) closeSheet();
    }
  }, [ticketPhase.phase, sheetOpen, closeSheet]);

  const bookNode = (
    <DepthBook
      symbol={instrument.symbol}
      state={depth.state}
      canPick={isPhone === true || ticketKind === 'LIMIT'}
      onPick={(price) => {
        setPick((p) => ({ price, seq: (p?.seq ?? 0) + 1 }));
        if (isPhone === true) {
          setKindCmd((c) => ({ kind: 'LIMIT', seq: (c?.seq ?? 0) + 1 }));
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setSheetOpen(true);
        }
      }}
      onShowMore={
        isPhone === true && phoneLevels < 25
          ? () => setPhoneLevels((n) => (n < 15 ? 15 : 25))
          : undefined
      }
    />
  );
  const openSheet = (side: 'BUY' | 'SELL', from: HTMLElement): void => {
    opener.current = from;
    setSideCmd((c) => ({ side, seq: (c?.seq ?? 0) + 1 }));
    setReopen((n) => n + 1); // an uncertain order that was dismissed shows "Retry safely" again
    setSheetOpen(true);
  };

  // the saved on/off choice of the shortcuts (this browser only)
  useEffect(() => {
    setShortcutsOn(loadShortcutsEnabled(browserStorageOrNull()));
  }, []);

  // keyboard shortcuts (D-106): UI state only, never an order; inactive while typing and while a dialog is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = resolveShortcut(e, e.target as HTMLElement | null, {
        enabled: shortcutsOn,
        dialogOpen: helpOpen || document.querySelector('dialog[open]') !== null,
      });
      if (action === null) return;
      if (action.type === 'side')
        setSideCmd((c) => ({ side: action.side, seq: (c?.seq ?? 0) + 1 }));
      else if (action.type === 'interval') setInterval((i) => stepInterval(i, action.delta));
      else if (action.type === 'help') setHelpOpen(true);
      else {
        const links = [...document.querySelectorAll<HTMLElement>('[data-testid="watch-link"]')];
        if (links.length === 0) return;
        const at = links.findIndex((l) => l === document.activeElement);
        const from =
          at >= 0 ? at : links.findIndex((l) => l.getAttribute('aria-current') === 'page');
        const next = stepIndex(from, action.delta, links.length);
        links[next]?.focus();
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcutsOn, helpOpen]);

  // the page title follows the price: "AAPL 195.00 · VANTAGE" (the title is not a live region: nothing is announced)
  const last = poll.quote.last;
  useEffect(() => {
    document.title = `${instrument.symbol}${last === undefined ? '' : ` ${formatPrice(last)}`} · VANTAGE`;
  }, [instrument.symbol, last]);
  return (
    <div data-testid="instrument-page" data-symbol={instrument.symbol}>
      {sv.explanation === null ? null : (
        <div className="px-4 pt-3 lg:px-6" data-testid="status-explanation">
          <Alert kind="info">{sv.explanation}</Alert>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-[112px_minmax(0,1fr)] xl:grid-cols-[270px_minmax(0,1fr)_330px]">
        <aside
          aria-label="Watchlist"
          data-testid="terminal-rail"
          className="order-3 border-line bg-bg-1 max-md:hidden lg:order-none lg:row-span-2 lg:border-r xl:row-span-1"
        >
          {isPhone === true ? null : (
            <WatchlistRail
              current={instrument.symbol}
              currentName={instrument.name}
              pollMs={props.quotePollMs}
              watchlist={watchlist}
            />
          )}
        </aside>
        <section
          aria-label="Chart"
          data-testid="terminal-center"
          className="order-1 flex min-w-0 flex-col gap-3 px-4 py-4 lg:order-none lg:px-5"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[22px] font-semibold leading-7 text-text-0">
              <span className="num" data-testid="instrument-symbol">
                {instrument.symbol}
              </span>
              <span className="text-[14px] font-normal text-text-1" data-testid="instrument-name">
                {instrument.name}
              </span>
            </h1>
            <button
              type="button"
              data-testid="shortcuts-open"
              onClick={() => setHelpOpen(true)}
              aria-label="Keyboard shortcuts"
              className="num rounded-md border border-line-strong px-2 py-0.5 text-[12px] text-text-1 hover:bg-bg-3 max-md:hidden"
            >
              ?
            </button>
            <button
              type="button"
              data-testid="watchlist-open"
              onClick={() => setWatchOpen(true)}
              className="inline-flex min-h-11 items-center rounded-md border border-line-strong px-3 text-[13px] text-text-0 md:hidden"
            >
              Watchlist
            </button>
            <WatchStar
              symbol={instrument.symbol}
              on={watchlist.state.symbols.includes(instrument.symbol)}
              disabled={watchlist.full}
              onToggle={() => watchlist.toggle(instrument.symbol, instrument.name)}
            />
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-2">
              <span>
                {instrument.exchange} · {ASSET_CLASS_LABELS[instrument.assetClass]} ·{' '}
                {instrument.currency}
              </span>
              <StatusBadge status={instrument.status} />
            </p>
          </div>
          <QuotePanel
            instrument={instrument}
            quote={poll.quote}
            market={props.market}
            refreshFailed={poll.refreshFailed}
          />
          <ChartPanel
            instrument={instrument}
            quote={poll.quote}
            interval={interval}
            onIntervalChange={setInterval}
          />
          <RecentOrders symbol={instrument.symbol} orders={props.orders} />
        </section>
        <aside
          aria-label="Order ticket and book"
          data-testid="terminal-right"
          className="order-2 grid min-w-0 gap-4 border-line bg-bg-1 px-4 py-4 lg:order-none lg:col-start-2 lg:grid-cols-2 xl:col-start-3 xl:row-start-1 xl:grid-cols-1 xl:border-l xl:px-5"
        >
          <TicketSheet open={sheetOpen} locked={locked} onClose={closeSheet}>
            <OrderTicket
              instrument={instrument}
              quote={poll.quote}
              refreshFailed={poll.refreshFailed}
              refreshQuote={poll.refreshNow}
              position={props.position}
              onKindChange={setTicketKind}
              pricePick={pick}
              sideCommand={sideCmd}
              kindCommand={kindCmd}
              onPhaseChange={setTicketPhase}
              keepAttemptOnDismiss={isPhone === true}
              reopenSignal={reopen}
              onSettled={() => {
                depth.refreshNow();
                portfolio.refreshNow();
                setOrdersRefresh((n) => n + 1);
              }}
            />
          </TicketSheet>
          <div className="space-y-4">
            <PositionPanel
              symbol={instrument.symbol}
              position={props.position}
              buyingPower={portfolio.data === null ? null : portfolio.data.cash}
            />
            {isPhone === true ? null : bookNode}
          </div>
        </aside>
      </div>
      <BottomPanel
        current={instrument.symbol}
        ordersPollMs={props.ordersPollMs}
        refreshSignal={ordersRefresh}
        bookPanel={isPhone === true ? bookNode : undefined}
      />
      <PhoneActionBar onBuy={(el) => openSheet('BUY', el)} onSell={(el) => openSheet('SELL', el)} />
      <FullScreenDrawer
        open={watchOpen && isPhone === true}
        onClose={() => setWatchOpen(false)}
        title="Watchlist"
        testId="watchlist-drawer"
      >
        {watchOpen && isPhone === true ? (
          <WatchlistRail
            current={instrument.symbol}
            currentName={instrument.name}
            pollMs={props.quotePollMs}
            watchlist={watchlist}
            full
            onSelect={() => setWatchOpen(false)}
          />
        ) : null}
      </FullScreenDrawer>
      <ShortcutsHelp
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        enabled={shortcutsOn}
        onEnabledChange={(on) => {
          setShortcutsOn(on);
          saveShortcutsEnabled(browserStorageOrNull(), on);
        }}
      />
    </div>
  );
}
