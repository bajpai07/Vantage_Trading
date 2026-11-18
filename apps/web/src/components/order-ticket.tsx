'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AccountResponse, OrderPreviewResponse, OrderResponse } from '@vantage/contracts';
import type { InstrumentItem, PositionResponse, QuoteItem } from '@vantage/contracts';
import { clientGet, clientRequest } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import { formatUtc } from '../lib/format';
import { DASH, formatMoney, formatPrice, formatQty } from '../lib/money';
import { rejectMessage } from '../lib/reject-copy';
import { loginUrlFor } from '../lib/return-to';
import {
  disabledReason,
  initialTicket,
  isRetryable,
  orderRequestBody,
  qtyComplete,
  qtyTooLarge,
  referencePriceFor,
  sanitizeLimitPrice,
  sanitizeQtyFor,
  stepDecimals,
  ticketReducer,
} from '../lib/ticket';
import type { OrderKind, Side, Tif } from '../lib/ticket';
import { Alert, inputClass, secondaryButtonClass } from './ui';

const PREVIEW_DEBOUNCE_MS = 300;

const BUY_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md bg-up px-4 py-2 text-[14px] font-semibold text-bg-0 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9';
const SELL_BUTTON = BUY_BUTTON.replace('bg-up', 'bg-down');

/**
 * The order ticket: MARKET orders. Quantities are decimal text up to the instrument's step (whole shares for stocks and ETFs,
 * up to 8 decimals for crypto); the server decides every rule. Every number shown (estimate, fee, cash after, fill price) is a string
 * from the API (the preview and the order response); this component does no money arithmetic. The logic lives in the
 * pure state machine of lib/ticket.ts (idempotency key lifecycle D-72, reference price D-71); this file renders it.
 */
export function OrderTicket(props: {
  instrument: InstrumentItem;
  quote: QuoteItem;
  refreshFailed: boolean;
  refreshQuote: () => void;
  position: PositionResponse | null | undefined;
}) {
  const { instrument, quote, refreshFailed, position } = props;
  const router = useRouter();
  const pathname = usePathname();
  const [t, dispatch] = useReducer(ticketReducer, initialTicket);
  const requestSeq = useRef(0);
  const inflight = useRef(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [cashNow, setCashNow] = useState<string | null | 'error'>(null);

  const symbol = instrument.symbol;
  const refPrice = referencePriceFor(t.side, quote);
  const reason = disabledReason({
    symbol,
    side: t.side,
    qty: t.qty,
    tradable: instrument.tradable,
    qtyStep: instrument.qtyStep,
    minQty: instrument.minQty,
    status: instrument.status,
    quote,
    refreshFailed,
    positionQty: position === undefined ? undefined : position === null ? null : position.qty,
    positionAvailable:
      position === undefined ? undefined : position === null ? null : position.qtyAvailable,
    kind: t.kind,
    limitPrice: t.limitPrice,
    tickSize: instrument.tickSize,
    preview: t.preview,
    submitting: t.phase === 'submitting',
  });
  // a preview is only asked for when nothing the ticket already knows blocks the order (the reasons before the preview)
  const preReason = disabledReason({
    symbol,
    side: t.side,
    qty: t.qty,
    tradable: instrument.tradable,
    qtyStep: instrument.qtyStep,
    minQty: instrument.minQty,
    status: instrument.status,
    quote,
    refreshFailed: false,
    positionQty: position === undefined ? undefined : position === null ? null : position.qty,
    positionAvailable:
      position === undefined ? undefined : position === null ? null : position.qtyAvailable,
    kind: t.kind,
    limitPrice: t.limitPrice,
    tickSize: instrument.tickSize,
    preview: { ...t.preview, status: 'ready', data: null },
    submitting: false,
  });
  // a LIMIT order needs no price from the quote (it rests); a MARKET order needs the price the user saw
  const canPreview =
    preReason === null &&
    (t.kind === 'LIMIT' || refPrice !== null) &&
    qtyComplete(t.qty) &&
    !qtyTooLarge(t.qty);
  const evaluable = quote.freshness === 'REAL_TIME' || quote.freshness === 'DELAYED';

  // "Max" (D-90): the server computes the largest quantity (the same engine code as the order); this only fills the string.
  // The reasons that do not depend on the quantity (not tradable, no usable price, nothing owned to sell) disable it.
  const maxReason = disabledReason({
    symbol,
    side: t.side,
    qty: instrument.minQty,
    tradable: instrument.tradable,
    qtyStep: instrument.qtyStep,
    minQty: instrument.minQty,
    status: instrument.status,
    quote,
    refreshFailed,
    positionQty: position === undefined ? undefined : position === null ? null : position.qty,
    positionAvailable:
      position === undefined ? undefined : position === null ? null : position.qtyAvailable,
    kind: t.kind,
    limitPrice: t.limitPrice,
    tickSize: instrument.tickSize,
    preview: { ...t.preview, status: 'ready', data: null },
    submitting: t.phase === 'submitting',
  });
  const [maxNote, setMaxNote] = useState<string | null>(null);
  const [maxBusy, setMaxBusy] = useState(false);
  useEffect(() => {
    setMaxNote(null);
  }, [t.side, t.qty]);
  async function fillMax(): Promise<void> {
    if (maxReason !== null || (t.kind === 'MARKET' && refPrice === null) || maxBusy) return;
    setMaxBusy(true);
    setMaxNote(null);
    // any valid quantity gets the answer: the maximum does not depend on it
    const ask = qtyComplete(t.qty) && !qtyTooLarge(t.qty) ? t.qty : instrument.minQty;
    const r = await clientRequest('POST', '/v1/orders/preview', OrderPreviewResponse, {
      body: orderRequestBody({
        symbol,
        side: t.side,
        kind: t.kind,
        qty: ask,
        referencePrice: refPrice ?? '',
        limitPrice: t.limitPrice,
        tif: t.tif,
      }),
    });
    setMaxBusy(false);
    if (!r.ok) {
      if (r.kind === 'unauthenticated') router.replace(loginUrlFor(pathname));
      else setMaxNote("We couldn't work out the maximum right now. Please try again.");
      return;
    }
    const m = r.data.maxQty;
    if (m === null || m === undefined) {
      setMaxNote('The maximum cannot be worked out right now, so orders are not available.');
    } else if (!qtyComplete(m)) {
      setMaxNote(
        t.side === 'BUY'
          ? 'Your cash does not cover even the smallest order.'
          : `You do not own any ${symbol} to sell.`,
      );
    } else {
      dispatch({ type: 'setQty', qty: m });
    }
  }

  // D-70: the live estimate, debounced, newest answer wins. Price-only changes re-preview too (the estimate stays on
  // screen, marked as updating, until the new one arrives).
  useEffect(() => {
    if (t.phase !== 'idle') return;
    if (!canPreview || (t.kind === 'MARKET' && refPrice === null)) {
      dispatch({ type: 'previewClear' });
      return;
    }
    const reference = t.kind === 'MARKET' ? (refPrice ?? '') : '';
    const timer = setTimeout(() => {
      const requestId = (requestSeq.current += 1);
      dispatch({
        type: 'previewStart',
        requestId,
        for: {
          side: t.side,
          qty: t.qty,
          referencePrice: reference,
          kind: t.kind,
          limitPrice: t.limitPrice,
          tif: t.tif,
        },
      });
      void (async () => {
        const r = await clientRequest('POST', '/v1/orders/preview', OrderPreviewResponse, {
          body: orderRequestBody({
            symbol,
            side: t.side,
            kind: t.kind,
            qty: t.qty,
            referencePrice: reference,
            limitPrice: t.limitPrice,
            tif: t.tif,
          }),
        });
        if (r.ok) dispatch({ type: 'previewOk', requestId, data: r.data });
        else if (r.kind === 'unauthenticated') router.replace(loginUrlFor(pathname));
        else dispatch({ type: 'previewFail', requestId, failure: r });
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    t.phase,
    canPreview,
    t.side,
    t.qty,
    t.kind,
    t.limitPrice,
    t.tif,
    refPrice,
    symbol,
    router,
    pathname,
  ]);

  // the review/result dialog is a native modal <dialog>: it traps focus, Escape closes it, and focus returns to the
  // button that opened it
  useEffect(() => {
    const d = dialogRef.current;
    if (d === null) return;
    if (t.phase !== 'idle' && !d.open) d.showModal();
    if (t.phase === 'idle' && d.open) d.close();
    if (t.phase !== 'idle') {
      const id = setTimeout(() => headingRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [t.phase, t.outcome?.kind]);

  // after a fill, ask the API for the cash balance now (a string, as received)
  const filled = t.outcome?.kind === 'filled';
  useEffect(() => {
    if (!filled) {
      setCashNow(null);
      return;
    }
    let cancelled = false;
    void clientGet('/v1/account', AccountResponse).then((r) => {
      if (!cancelled) setCashNow(r.ok ? r.data.cash : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [filled]);

  function openReview(e?: FormEvent): void {
    e?.preventDefault();
    if (reason !== null) return;
    dispatch({ type: 'openReview', key: crypto.randomUUID(), symbol });
  }

  async function submit(): Promise<void> {
    const a = t.attempt;
    if (a === null || inflight.current) return; // a second click while the first is in flight does nothing
    inflight.current = true;
    dispatch({ type: 'submitStart' });
    const r = await clientRequest('POST', '/v1/orders', OrderResponse, {
      headers: { 'Idempotency-Key': a.key },
      body: orderRequestBody({
        symbol: a.symbol,
        side: a.side,
        kind: a.kind,
        qty: a.qty,
        referencePrice: a.referencePrice,
        limitPrice: a.limitPrice,
        tif: a.tif,
      }),
    });
    inflight.current = false;
    if (r.ok) {
      dispatch({ type: 'submitDone', order: r.data });
      if (r.data.status === 'FILLED' || r.data.status === 'ACCEPTED')
        router.refresh(); // the position, the reserved cash and recent orders update without a reload
      else if (r.data.rejectCode === 'PRICE_MOVED') props.refreshQuote(); // show the current price
    } else if (r.kind === 'unauthenticated') {
      router.replace(loginUrlFor(pathname));
    } else if (isRetryable(r)) {
      dispatch({ type: 'submitRetryable', failure: r });
    } else {
      dispatch({ type: 'submitFailed', failure: r });
    }
  }

  const closeDone = (): void => dispatch({ type: 'reset' });
  const est = t.preview.data;
  const updating = t.preview.status === 'loading' && est !== null;

  return (
    <section
      aria-labelledby="ticket-title"
      data-testid="order-ticket"
      className="rounded-md border border-line bg-bg-1 p-3"
    >
      <h2 id="ticket-title" className="mb-2 text-[16px] font-semibold leading-[22px] text-text-0">
        Order ticket
      </h2>
      <form
        onSubmit={openReview}
        noValidate
        aria-label={t.kind === 'LIMIT' ? 'Limit order' : 'Market order'}
      >
        <fieldset className="mb-3">
          <legend className="mb-1 text-[12px] text-text-2">Order type</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['MARKET', 'LIMIT'] as const).map((kind: OrderKind) => (
              <label
                key={kind}
                className={`flex min-h-11 cursor-pointer items-center justify-center rounded-md border text-[13px] font-semibold md:min-h-9 ${
                  t.kind === kind
                    ? 'border-accent bg-bg-3 text-text-0'
                    : 'border-line-strong text-text-1 hover:bg-bg-3'
                }`}
              >
                <input
                  type="radio"
                  name="kind"
                  value={kind}
                  checked={t.kind === kind}
                  onChange={() => dispatch({ type: 'setKind', kind })}
                  className="sr-only"
                  data-testid={`kind-${kind.toLowerCase()}`}
                />
                {kind === 'MARKET' ? 'Market' : 'Limit'}
                {t.kind === kind ? <span className="sr-only"> (selected)</span> : null}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mb-3">
          <legend className="mb-1 text-[12px] text-text-2">Side</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['BUY', 'SELL'] as const).map((side: Side) => (
              <label
                key={side}
                className={`flex min-h-11 cursor-pointer items-center justify-center rounded-md border text-[13px] font-semibold md:min-h-9 ${
                  t.side === side
                    ? side === 'BUY'
                      ? 'border-up bg-up-bg text-up'
                      : 'border-down bg-down-bg text-down'
                    : 'border-line-strong text-text-1 hover:bg-bg-3'
                }`}
              >
                <input
                  type="radio"
                  name="side"
                  value={side}
                  checked={t.side === side}
                  onChange={() => dispatch({ type: 'setSide', side })}
                  className="sr-only"
                  data-testid={`side-${side.toLowerCase()}`}
                />
                <span aria-hidden="true">{side === 'BUY' ? '▲ ' : '▼ '}</span>
                {side === 'BUY' ? 'Buy' : 'Sell'}
                {t.side === side ? <span className="sr-only"> (selected)</span> : null}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mb-3">
          <label htmlFor="ticket-qty" className="mb-1 block text-[12px] text-text-2">
            {stepDecimals(instrument.qtyStep) === 0 ? 'Quantity (whole shares)' : 'Quantity'}
          </label>
          <div className="flex gap-2">
            <input
              id="ticket-qty"
              name="qty"
              data-testid="ticket-qty"
              inputMode="decimal"
              autoComplete="off"
              maxLength={16}
              value={t.qty}
              aria-describedby="ticket-qty-help ticket-reason"
              onBeforeInput={(e) => {
                const data = (e.nativeEvent as InputEvent).data;
                if (data !== null && data !== undefined && !/^[0-9.]+$/.test(data))
                  e.preventDefault();
              }}
              onPaste={(e) => {
                if (!/^[0-9]*\.?[0-9]*$/.test(e.clipboardData.getData('text').trim()))
                  e.preventDefault();
              }}
              onChange={(e) =>
                dispatch({
                  type: 'setQty',
                  qty: sanitizeQtyFor(e.target.value, instrument.qtyStep),
                })
              }
              className={`${inputClass} num`}
            />
            <button
              type="button"
              data-testid="ticket-max"
              onClick={() => void fillMax()}
              disabled={maxReason !== null || maxBusy}
              aria-label={`Max: fill the largest quantity you can ${t.side === 'BUY' ? 'buy' : 'sell'}`}
              className={secondaryButtonClass}
            >
              Max
            </button>
          </div>
          <p
            id="ticket-qty-help"
            data-testid="ticket-qty-help"
            className="mt-1 text-[12px] text-text-2"
          >
            {stepDecimals(instrument.qtyStep) === 0
              ? `Whole shares only · minimum ${formatQty(instrument.minQty)}`
              : `Steps of ${formatQty(instrument.qtyStep)} · minimum ${formatQty(instrument.minQty)}`}
          </p>
          <p
            role="status"
            data-testid="ticket-max-note"
            className="min-h-[0px] text-[12px] text-text-1"
          >
            {maxNote}
          </p>
        </div>

        {t.kind === 'LIMIT' ? (
          <div className="mb-3">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label htmlFor="ticket-limit" className="mb-1 block text-[12px] text-text-2">
                  Limit price (USD)
                </label>
                <input
                  id="ticket-limit"
                  name="limitPrice"
                  data-testid="ticket-limit"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={21}
                  value={t.limitPrice}
                  aria-describedby="ticket-limit-help ticket-reason"
                  onBeforeInput={(e) => {
                    const data = (e.nativeEvent as InputEvent).data;
                    if (data !== null && data !== undefined && !/^[0-9.]+$/.test(data))
                      e.preventDefault();
                  }}
                  onPaste={(e) => {
                    if (!/^[0-9]*\.?[0-9]*$/.test(e.clipboardData.getData('text').trim()))
                      e.preventDefault();
                  }}
                  onChange={(e) =>
                    dispatch({
                      type: 'setLimitPrice',
                      limitPrice: sanitizeLimitPrice(e.target.value),
                    })
                  }
                  className={`${inputClass} num`}
                />
              </div>
              <div>
                <label htmlFor="ticket-tif" className="mb-1 block text-[12px] text-text-2">
                  Time in force
                </label>
                <select
                  id="ticket-tif"
                  name="tif"
                  data-testid="ticket-tif"
                  value={t.tif}
                  onChange={(e) => dispatch({ type: 'setTif', tif: e.target.value as Tif })}
                  className={inputClass}
                >
                  <option value="DAY">Day</option>
                  <option value="GTC">Good till cancelled</option>
                </select>
              </div>
            </div>
            <p
              id="ticket-limit-help"
              data-testid="ticket-limit-help"
              className="mt-1 text-[12px] text-text-2"
            >
              Price step {formatPrice(instrument.tickSize)}. A buy holds its cash, a sell holds its
              quantity, until the order fills, is cancelled or expires.
            </p>
            {evaluable ? null : (
              <p data-testid="limit-rest-note" className="text-[12px] text-text-1">
                The market is not live right now: this order will be evaluated when the market is
                open and the quote is live.
              </p>
            )}
          </div>
        ) : null}

        <div
          className={`mb-3 rounded-md border border-line bg-bg-2 px-3 py-2 text-[12px] ${updating ? 'opacity-60' : ''}`}
          data-testid="ticket-estimate"
          aria-busy={t.preview.status === 'loading'}
        >
          <p className="mb-1 text-text-2" data-testid="estimate-label" title={est?.disclaimer}>
            Estimate — final price is decided when the order executes.
          </p>
          {est === null ? (
            <p className="text-text-2" data-testid="estimate-empty">
              {t.preview.status === 'loading' ? 'Calculating…' : DASH}
            </p>
          ) : t.kind === 'LIMIT' ? (
            <dl className="num grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              <dt className="text-text-2">What happens</dt>
              <dd className="text-right text-text-0" data-testid="estimate-mode">
                {est.marketable === true
                  ? `Fills now at about ${est.estimatedPrice === null ? DASH : formatPrice(est.estimatedPrice)}`
                  : 'Rests until filled, cancelled or expired'}
              </dd>
              {t.side === 'BUY' ? (
                <>
                  <dt className="text-text-2">Cash held back</dt>
                  <dd className="text-right text-text-0" data-testid="estimate-reserve">
                    {est.reserveUsd === null || est.reserveUsd === undefined
                      ? DASH
                      : formatMoney(est.reserveUsd)}
                  </dd>
                </>
              ) : null}
              <dt className="text-text-2">Cash after</dt>
              <dd className="text-right text-text-0" data-testid="estimate-cash-after">
                {formatMoney(est.estimatedCashAfter)}
              </dd>
              {est.marketable === true ? null : (
                <>
                  <dt className="text-text-2">Expires</dt>
                  <dd className="text-right text-text-0" data-testid="estimate-expires">
                    {est.expiresAt === null || est.expiresAt === undefined
                      ? DASH
                      : formatUtc(est.expiresAt)}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <dl className="num grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              <dt className="text-text-2">Estimated price</dt>
              <dd className="text-right text-text-0" data-testid="estimate-price">
                {est.estimatedPrice === null ? DASH : formatPrice(est.estimatedPrice)}
              </dd>
              <dt className="text-text-2">
                {t.side === 'BUY' ? 'Estimated cost' : 'Estimated value'}
              </dt>
              <dd className="text-right text-text-0" data-testid="estimate-notional">
                {formatMoney(est.estimatedNotional)}
              </dd>
              <dt className="text-text-2">Fee</dt>
              <dd className="text-right text-text-0" data-testid="estimate-fee">
                {formatMoney(est.estimatedFee)}
              </dd>
              {t.side === 'SELL' ? (
                <>
                  <dt className="text-text-2">Estimated proceeds</dt>
                  <dd className="text-right text-text-0" data-testid="estimate-proceeds">
                    {formatMoney(est.estimatedProceeds)}
                  </dd>
                </>
              ) : null}
              <dt className="text-text-2">Cash after</dt>
              <dd className="text-right text-text-0" data-testid="estimate-cash-after">
                {formatMoney(est.estimatedCashAfter)}
              </dd>
            </dl>
          )}
        </div>

        <p
          id="ticket-reason"
          data-testid="ticket-reason"
          data-reason={reason === null ? 'none' : 'blocked'}
          className="mb-2 min-h-[18px] text-[12px] text-text-1"
        >
          {reason === null ? null : (
            <>
              <span aria-hidden="true" className="text-warn">
                ▲{' '}
              </span>
              {reason}
            </>
          )}
        </p>
        <button
          type="submit"
          disabled={reason !== null}
          data-testid="review-button"
          className={t.side === 'BUY' ? BUY_BUTTON : SELL_BUTTON}
        >
          {t.side === 'BUY' ? 'Review buy order' : 'Review sell order'}
          {t.kind === 'LIMIT' ? ' (limit)' : ''}
        </button>
      </form>

      <dialog
        ref={dialogRef}
        aria-labelledby="ticket-dialog-title"
        data-testid="ticket-dialog"
        onCancel={(e) => {
          e.preventDefault(); // Escape never leaves a half-state: it is handled here
          if (t.phase === 'review') dispatch({ type: 'cancelReview' });
          else if (t.phase === 'done') closeDone();
        }}
        className="m-auto w-[min(92vw,440px)] rounded-lg border border-line-strong bg-bg-1 p-4 text-text-1 backdrop:bg-bg-0/80"
      >
        {t.attempt !== null && (t.phase === 'review' || t.phase === 'submitting') ? (
          <div>
            <h2
              id="ticket-dialog-title"
              ref={headingRef}
              tabIndex={-1}
              className="mb-1 text-[16px] font-semibold text-text-0"
            >
              Review your order
            </h2>
            <p className="mb-3 text-[13px]" data-testid="review-summary">
              <strong className={t.attempt.side === 'BUY' ? 'text-up' : 'text-down'}>
                {t.attempt.side === 'BUY' ? 'Buy' : 'Sell'}
              </strong>{' '}
              <span className="num text-text-0">
                {formatQty(t.attempt.qty)} {t.attempt.symbol}
              </span>{' '}
              {t.attempt.kind === 'LIMIT' ? (
                <>
                  with a limit of{' '}
                  <span className="num text-text-0">{formatPrice(t.attempt.limitPrice)}</span> (
                  {t.attempt.tif === 'GTC' ? 'good till cancelled' : 'day order'}).
                </>
              ) : (
                <>
                  at about{' '}
                  <span className="num text-text-0">
                    {t.attempt.estimate.estimatedPrice === null
                      ? DASH
                      : formatPrice(t.attempt.estimate.estimatedPrice)}
                  </span>
                  . Market order.
                </>
              )}
            </p>
            {t.attempt.kind === 'LIMIT' ? (
              <p className="mb-3 text-[13px] text-text-0" data-testid="review-mode">
                {t.attempt.estimate.marketable === true
                  ? `Fills now at about ${t.attempt.estimate.estimatedPrice === null ? DASH : formatPrice(t.attempt.estimate.estimatedPrice)}.`
                  : 'Resting until filled, cancelled or expired.'}
              </p>
            ) : null}
            <dl className="num mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-bg-2 px-3 py-2 text-[13px]">
              {t.attempt.kind === 'LIMIT' && t.attempt.estimate.marketable !== true ? (
                <>
                  {t.attempt.side === 'BUY' ? (
                    <>
                      <dt className="text-text-2">Cash held back</dt>
                      <dd className="text-right text-text-0" data-testid="review-reserve">
                        {formatMoney(t.attempt.estimate.reserveUsd)}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-text-2">Quantity held back</dt>
                      <dd className="text-right text-text-0" data-testid="review-reserve">
                        {formatQty(t.attempt.qty)} {t.attempt.symbol}
                      </dd>
                    </>
                  )}
                  <dt className="text-text-2">Expires</dt>
                  <dd className="text-right text-text-0" data-testid="review-expires">
                    {t.attempt.estimate.expiresAt === null ||
                    t.attempt.estimate.expiresAt === undefined
                      ? DASH
                      : formatUtc(t.attempt.estimate.expiresAt)}
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-text-2">
                    {t.attempt.side === 'BUY' ? 'Estimated cost' : 'Estimated value'}
                  </dt>
                  <dd className="text-right text-text-0" data-testid="review-notional">
                    {formatMoney(t.attempt.estimate.estimatedNotional)}
                  </dd>
                  <dt className="text-text-2">Fee</dt>
                  <dd className="text-right text-text-0" data-testid="review-fee">
                    {formatMoney(t.attempt.estimate.estimatedFee)}
                  </dd>
                </>
              )}
              {t.attempt.side === 'SELL' ? (
                <>
                  <dt className="text-text-2">Estimated proceeds</dt>
                  <dd className="text-right text-text-0">
                    {formatMoney(t.attempt.estimate.estimatedProceeds)}
                  </dd>
                </>
              ) : null}
              <dt className="text-text-2">Cash after</dt>
              <dd className="text-right text-text-0" data-testid="review-cash-after">
                {formatMoney(t.attempt.estimate.estimatedCashAfter)}
              </dd>
            </dl>
            <p className="mb-3 text-[12px] text-text-2" data-testid="review-disclaimer">
              Estimate — final price is decided when the order executes. Based on the price as of{' '}
              <span className="num">{formatUtc(t.attempt.estimate.quote.asOf)}</span> (
              {t.attempt.estimate.quote.freshness}, source {t.attempt.estimate.quote.source}).
              Simulated order, virtual money.
            </p>
            <div aria-live="polite" role="status" data-testid="review-status">
              {t.phase === 'submitting' ? (
                <p className="mb-3 text-[13px] text-text-0" data-testid="awaiting-server">
                  Awaiting server… Please do not close this window.
                </p>
              ) : null}
              {t.outcome?.kind === 'retryable' ? (
                <div className="mb-3" data-testid="retry-notice">
                  <Alert kind="error" support={describeFailure(t.outcome.failure, 'load').support}>
                    We couldn't confirm your order.{' '}
                    {describeFailure(t.outcome.failure, 'load').message} It may or may not have been
                    placed. You can retry safely: the same request cannot place it twice, or check{' '}
                    <Link href="/orders" className="font-medium text-text-0! underline">
                      your orders
                    </Link>
                    .
                  </Alert>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => dispatch({ type: 'cancelReview' })}
                disabled={t.phase === 'submitting'}
                className={secondaryButtonClass}
                data-testid="review-edit"
              >
                Edit order
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={t.phase === 'submitting'}
                aria-busy={t.phase === 'submitting'}
                data-testid="confirm-button"
                className={`${t.attempt.side === 'BUY' ? BUY_BUTTON : SELL_BUTTON} !w-auto`}
              >
                {t.phase === 'submitting'
                  ? 'Placing your order…'
                  : t.outcome?.kind === 'retryable'
                    ? 'Retry safely'
                    : `${t.attempt.side === 'BUY' ? 'Buy' : 'Sell'} ${formatQty(t.attempt.qty)} ${t.attempt.symbol}${t.attempt.kind === 'LIMIT' ? ' (limit)' : ''}`}
              </button>
            </div>
          </div>
        ) : null}

        {t.phase === 'done' && t.outcome !== null && t.outcome.kind === 'accepted' ? (
          <div aria-live="polite" role="status" data-testid="result-accepted">
            <h2
              id="ticket-dialog-title"
              ref={headingRef}
              tabIndex={-1}
              className="mb-2 text-[16px] font-semibold text-text-0"
            >
              <span aria-hidden="true" className="text-up">
                ●{' '}
              </span>
              Order placed
            </h2>
            <p className="mb-2 text-[13px] text-text-0" data-testid="result-accepted-text">
              Your limit order is resting until it fills, you cancel it or it expires.
            </p>
            <dl className="num mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-bg-2 px-3 py-2 text-[13px]">
              <dt className="text-text-2">Order</dt>
              <dd className="text-right text-text-0" data-testid="result-order">
                {t.outcome.order.side === 'BUY' ? 'Buy' : 'Sell'} {formatQty(t.outcome.order.qty)}{' '}
                {t.outcome.order.symbol}
              </dd>
              <dt className="text-text-2">Limit price</dt>
              <dd className="text-right text-text-0" data-testid="result-limit">
                {t.outcome.order.limitPrice === null
                  ? DASH
                  : formatPrice(t.outcome.order.limitPrice)}
              </dd>
              {t.outcome.order.side === 'BUY' ? (
                <>
                  <dt className="text-text-2">Cash held back</dt>
                  <dd className="text-right text-text-0" data-testid="result-reserved">
                    {formatMoney(t.outcome.order.reservedUsd)}
                  </dd>
                </>
              ) : null}
              <dt className="text-text-2">Expires</dt>
              <dd className="text-right text-text-0" data-testid="result-expires">
                {t.outcome.order.expiresAt === null ? DASH : formatUtc(t.outcome.order.expiresAt)}
              </dd>
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href="/orders" className="text-[13px] underline" data-testid="result-link">
                View in your orders
              </Link>
              <button
                type="button"
                onClick={closeDone}
                className={secondaryButtonClass}
                data-testid="result-close"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        {t.phase === 'done' && t.outcome !== null && t.outcome.kind === 'filled' ? (
          <div aria-live="polite" role="status" data-testid="result-filled">
            <h2
              id="ticket-dialog-title"
              ref={headingRef}
              tabIndex={-1}
              className="mb-2 text-[16px] font-semibold text-text-0"
            >
              <span aria-hidden="true" className="text-up">
                ✓{' '}
              </span>
              Order filled
            </h2>
            {t.outcome.order.execution === null ? null : (
              <dl className="num mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-bg-2 px-3 py-2 text-[13px]">
                <dt className="text-text-2">
                  {t.outcome.order.side === 'BUY' ? 'Bought' : 'Sold'}
                </dt>
                <dd className="text-right text-text-0" data-testid="result-qty">
                  {formatQty(t.outcome.order.execution.qty)} {t.outcome.order.symbol}
                </dd>
                <dt className="text-text-2">Price</dt>
                <dd className="text-right text-text-0" data-testid="result-price">
                  {formatPrice(t.outcome.order.execution.price)}
                </dd>
                <dt className="text-text-2">Value</dt>
                <dd className="text-right text-text-0" data-testid="result-notional">
                  {formatMoney(t.outcome.order.execution.notional)}
                </dd>
                <dt className="text-text-2">Fee</dt>
                <dd className="text-right text-text-0" data-testid="result-fee">
                  {formatMoney(t.outcome.order.execution.fee)}
                </dd>
                <dt className="text-text-2">Cash now</dt>
                <dd className="text-right text-text-0" data-testid="result-cash">
                  {cashNow === null
                    ? 'Checking…'
                    : cashNow === 'error'
                      ? DASH
                      : formatMoney(cashNow)}
                </dd>
              </dl>
            )}
            <p className="mb-3 text-[12px] text-text-2">
              Filled against the quote as of{' '}
              <span className="num">{formatUtc(t.outcome.order.execution?.executedAt)}</span> (
              {t.outcome.order.execution?.quoteSource}). Simulated order, virtual money.
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href="/orders" className="text-[13px] underline" data-testid="result-link">
                View in your orders
              </Link>
              <button
                type="button"
                onClick={closeDone}
                className={secondaryButtonClass}
                data-testid="result-close"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        {t.phase === 'done' && t.outcome !== null && t.outcome.kind === 'rejected' ? (
          <div aria-live="polite" role="status" data-testid="result-rejected">
            <h2
              id="ticket-dialog-title"
              ref={headingRef}
              tabIndex={-1}
              className="mb-2 text-[16px] font-semibold text-text-0"
            >
              <span aria-hidden="true" className="text-down">
                ✕{' '}
              </span>
              Order not filled
            </h2>
            <p className="mb-2 text-[13px] text-text-0" data-testid="result-reason">
              {rejectMessage(t.outcome.order.rejectCode, {
                qtyStep: instrument.qtyStep,
                minQty: instrument.minQty,
                assetClass: instrument.assetClass,
              })}
            </p>
            <p className="mb-3 text-[12px] text-text-2">
              Nothing was changed: no money moved and no shares were bought or sold.
            </p>
            {t.outcome.order.rejectCode === 'PRICE_MOVED' ? (
              <p className="mb-3 text-[13px]" data-testid="price-moved">
                The current {t.side === 'BUY' ? 'ask' : 'bid'} is{' '}
                <span className="num text-text-0" data-testid="price-moved-new-price">
                  {refPrice === null ? DASH : formatPrice(refPrice)}
                </span>
                . Nothing is resubmitted automatically: review the order again to confirm at the new
                price.
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={closeDone}
                className={secondaryButtonClass}
                data-testid="result-close"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: 'reviewAgain' });
                  props.refreshQuote();
                }}
                className={secondaryButtonClass}
                data-testid="review-again"
              >
                Review again
              </button>
            </div>
          </div>
        ) : null}

        {t.phase === 'done' && t.outcome !== null && t.outcome.kind === 'failed' ? (
          <div aria-live="polite" role="status" data-testid="result-error">
            <h2
              id="ticket-dialog-title"
              ref={headingRef}
              tabIndex={-1}
              className="mb-2 text-[16px] font-semibold text-text-0"
            >
              <span aria-hidden="true" className="text-down">
                ✕{' '}
              </span>
              Order not placed
            </h2>
            <div className="mb-3">
              <Alert kind="error" support={describeFailure(t.outcome.failure, 'load').support}>
                {describeFailure(t.outcome.failure, 'load').message}
              </Alert>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={closeDone}
                className={secondaryButtonClass}
                data-testid="result-close"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
