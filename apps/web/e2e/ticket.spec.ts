// The order ticket end to end (M6b T5): search -> instrument -> estimate -> review -> confirm -> result, against the real
// API, real Postgres and FIXTURE data. Money checks compare strings the API produced; reconciliation runs the API's own
// zero-tolerance reconcile on the database.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  BUY_AAPL_10,
  apiGet,
  clearQuote,
  control,
  counts,
  enterQty,
  placeOrder,
  reconcile,
  register,
  setQuote,
} from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const SHOTS = '../../docs/phase-reports/m6b';

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
  await setQuote('MSFT', '419.90', '420.00', { last: '419.95' });
});

const sellSide = (page: Page) => page.locator('label:has([data-testid="side-sell"])').click();
const buySide = (page: Page) => page.locator('label:has([data-testid="side-buy"])').click();
const reviewButton = (page: Page) => page.getByTestId('review-button');
const dialog = (page: Page) => page.getByTestId('ticket-dialog');

/** Types the quantity and waits until the estimate for it is on screen and Review is enabled. */
async function readyToReview(page: Page, qty: string): Promise<void> {
  await enterQty(page, qty);
  await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('estimate-price')).toBeVisible();
}

async function review(page: Page, qty: string): Promise<void> {
  await readyToReview(page, qty);
  await reviewButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('confirm-button')).toBeEnabled();
}

async function buyAndWait(page: Page, qty: string): Promise<void> {
  await review(page, qty);
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-filled')).toBeVisible();
}

/** Collects every POST to /v1/orders (not the preview) with its idempotency key. */
function recordOrderPosts(page: Page): { keys: string[] } {
  const rec = { keys: [] as string[] };
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/orders') {
      rec.keys.push(r.headers()['idempotency-key'] ?? '');
    }
  });
  return rec;
}

test.describe('1. search, estimate and a fill (golden vector A)', () => {
  test('search AAPL, open it, buy 10: estimate, review, fill; cash 8,099.60 and the position are exact; reconciles clean', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.keyboard.press('/');
    await page.keyboard.type('AAPL');
    await page.getByTestId('search-option').first().click();
    await page.waitForURL('**/instruments/AAPL');

    // empty form: Review is disabled, with the reason
    await expect(reviewButton(page)).toBeDisabled();
    await expect(page.getByTestId('ticket-reason')).toHaveText(/Enter a quantity/);

    await enterQty(page, '10');
    await expect(page.getByTestId('estimate-price')).toHaveText('190.04', { timeout: 10_000 });
    await expect(page.getByTestId('estimate-notional')).toHaveText('1,900.40');
    await expect(page.getByTestId('estimate-fee')).toHaveText('0.00');
    await expect(page.getByTestId('estimate-cash-after')).toHaveText('8,099.60');
    await expect(page.getByTestId('estimate-label')).toContainText(
      'Estimate — final price is decided when the order executes.',
    );
    await expect(reviewButton(page)).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/ticket-estimate-1280.png`, fullPage: true });

    await reviewButton(page).click();
    await expect(page.getByTestId('review-summary')).toContainText('Buy 10 AAPL');
    await expect(page.getByTestId('review-cash-after')).toHaveText('8,099.60');
    await expect(page.getByTestId('confirm-button')).toHaveText('Buy 10 AAPL');
    await page.screenshot({ path: `${SHOTS}/ticket-review-1280.png` });
    await page.getByTestId('confirm-button').click();

    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-price')).toHaveText('190.04');
    await expect(page.getByTestId('result-qty')).toHaveText('10 AAPL');
    await expect(page.getByTestId('result-notional')).toHaveText('1,900.40');
    await expect(page.getByTestId('result-fee')).toHaveText('0.00');
    await expect(page.getByTestId('result-cash')).toHaveText('8,099.60');
    await page.screenshot({ path: `${SHOTS}/ticket-filled-1280.png` });
    await page.getByTestId('result-close').click();

    // the position and recent orders on the page update without a reload
    await expect(page.getByTestId('position-qty')).toHaveText('10');
    await expect(page.getByTestId('position-avg-cost')).toHaveText('190.04');
    await expect(page.getByTestId('recent-order')).toHaveCount(1);

    const account = await apiGet<{ cash: string }>(context, '/v1/account');
    expect(account.cash).toBe('8099.6000000000'.slice(0, account.cash.length));
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('2. selling: part, then all', () => {
  test('realised P&L on the portfolio equals the API string after each sale; reconciles clean', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    await buyAndWait(page, '10');
    await page.getByTestId('result-close').click();

    await sellSide(page);
    await expect(page.getByTestId('estimate-proceeds')).toHaveCount(0);
    await readyToReview(page, '4');
    await expect(page.getByTestId('estimate-proceeds')).toBeVisible();
    await reviewButton(page).click();
    await expect(page.getByTestId('confirm-button')).toHaveText('Sell 4 AAPL');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-price')).toHaveText('189.91'); // bid 189.95 less slippage
    await page.getByTestId('result-close').click();
    await expect(page.getByTestId('position-qty')).toHaveText('6');

    const afterPart = await apiGet<{ realisedPnl: string }>(context, '/v1/portfolio');
    expect(afterPart.realisedPnl.startsWith('-')).toBe(true); // sold 4 @ 189.91 against a cost of 190.04
    await page.goto('/portfolio');
    const digits = (s: string) => s.replace(/[^0-9.]/g, '');
    expect(digits(await page.getByTestId('metric-realised').innerText())).toBe(
      digits(afterPart.realisedPnl)
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, ''),
    );

    await page.goto('/instruments/AAPL');
    await sellSide(page);
    await readyToReview(page, '6');
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await page.getByTestId('result-close').click();
    await expect(page.getByTestId('position-none')).toHaveText('You do not hold AAPL.');

    const afterAll = await apiGet<{ realisedPnl: string; cash: string }>(context, '/v1/portfolio');
    expect(afterAll.realisedPnl).not.toBe(afterPart.realisedPnl);
    await page.goto('/activity');
    await expect(page.getByTestId('realised').first()).toBeVisible();
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('3. one click, one order', () => {
  test('a double click on Confirm places exactly one order', async ({ page }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const posts = recordOrderPosts(page);
    await review(page, '2');
    await page.getByTestId('confirm-button').dblclick();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(posts.keys).toHaveLength(1);
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
  });

  test('50 clicks in the same instant place exactly one order (control: one click places one)', async ({
    page,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const posts = recordOrderPosts(page);
    await review(page, '3');
    await page.getByTestId('confirm-button').evaluate((el) => {
      for (let i = 0; i < 50; i += 1) (el as HTMLButtonElement).click(); // synchronously, before React re-renders
    });
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(posts.keys).toHaveLength(1);
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('4. a network failure after the request was sent', () => {
  test('the order was placed but the answer was lost: retry reuses the key and there is still exactly one order', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const posts = recordOrderPosts(page);
    let first = true;
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() === 'POST' && first) {
          first = false;
          await route.fetch(); // the API receives it and places the order ...
          await route.abort('connectionreset'); // ... and the browser never gets the answer
        } else await route.continue();
      },
    );
    await review(page, '5');
    await page.getByTestId('confirm-button').click();
    const notice = page.getByTestId('retry-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("We couldn't confirm your order");
    await expect(notice).toContainText('retry safely');
    await expect(notice.getByRole('link', { name: 'your orders' })).toHaveAttribute(
      'href',
      '/orders',
    );
    await expect(page.getByTestId('confirm-button')).toHaveText('Retry safely');
    await page.screenshot({ path: `${SHOTS}/ticket-retry-1280.png` });

    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(posts.keys).toHaveLength(2);
    expect(posts.keys[0]).toMatch(/\S/);
    expect(posts.keys[1]).toBe(posts.keys[0]); // the same key
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
    const orders = await apiGet<{ orders: { status: string }[] }>(context, '/v1/orders');
    expect(orders.orders).toHaveLength(1);
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });

  test('the request never arrived: retry also uses the same key, and the order is placed once', async ({
    page,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const posts = recordOrderPosts(page);
    let first = true;
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() === 'POST' && first) {
          first = false;
          await route.abort('connectionrefused');
        } else await route.continue();
      },
    );
    await review(page, '5');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('retry-notice')).toBeVisible();
    expect(await counts(email)).toEqual({ orders: '0', executions: '0' });
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(posts.keys[1]).toBe(posts.keys[0]);
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
  });
});

test.describe('5. editing during review', () => {
  test('editing the quantity gives a new key and no stale estimate is submitted', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const posts = recordOrderPosts(page);
    let first = true;
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() === 'POST' && first) {
          first = false;
          await route.abort('connectionrefused'); // attempt 1 fails before reaching the API
        } else await route.continue();
      },
    );
    await review(page, '10');
    await expect(page.getByTestId('review-notional')).toHaveText('1,900.40');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('retry-notice')).toBeVisible();

    await page.getByTestId('review-edit').click();
    await expect(dialog(page)).toBeHidden();
    await enterQty(page, '11');
    await expect(page.getByTestId('estimate-notional')).not.toHaveText('1,900.40'); // the old estimate is gone
    await expect(page.getByTestId('estimate-notional')).toHaveText('2,090.44', { timeout: 10_000 });
    await reviewButton(page).click();
    await expect(page.getByTestId('review-notional')).toHaveText('2,090.44');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();

    expect(posts.keys).toHaveLength(2);
    expect(posts.keys[1]).not.toBe(posts.keys[0]); // a new attempt, a new key
    const positions = await apiGet<{ positions: { symbol: string; qty: string }[] }>(
      context,
      '/v1/positions',
    );
    expect(positions.positions.map((p) => [p.symbol, p.qty])).toEqual([['AAPL', '11']]);
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
  });
});

test.describe('6. states that block an order say why', () => {
  const REASONS: [string, RegExp][] = [
    ['STALE', /too old to trade/],
    ['CLOSED', /market is closed/],
    ['UNAVAILABLE', /no usable price/],
  ];

  test('STALE, CLOSED and UNAVAILABLE quotes disable Review with the reason; control: a fresh quote enables it', async ({
    page,
  }) => {
    await register(page);
    for (const [state, text] of REASONS) {
      await setQuote('AAPL', '189.95', '190.00');
      if (state === 'STALE') await setQuote('AAPL', '189.95', '190.00', { ageSeconds: 2000 });
      if (state === 'CLOSED') await control('/clock', { iso: '2026-11-10T23:00:00.000Z' });
      if (state === 'UNAVAILABLE') await clearQuote('AAPL');
      await page.goto('/instruments/AAPL');
      await enterQty(page, '10');
      await expect(reviewButton(page), state).toBeDisabled();
      await expect(page.getByTestId('ticket-reason'), state).toHaveText(text);
      await control('/clock', { iso: OPEN });
    }
    await setQuote('AAPL', '189.95', '190.00'); // control
    await page.goto('/instruments/AAPL');
    await readyToReview(page, '10');
    await expect(page.getByTestId('ticket-reason')).toHaveAttribute('data-reason', 'none');
  });

  test('HALTED blocks both sides; SELL_ONLY blocks only buying (a holder can still sell); ACTIVE is enabled', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, { ...BUY_AAPL_10, symbol: 'MSFT', referencePrice: '420.00' }); // a MSFT position
    try {
      await control('/instrument', { symbol: 'MSFT', status: 'HALTED' });
      await page.goto('/instruments/MSFT');
      await enterQty(page, '1');
      await expect(reviewButton(page)).toBeDisabled();
      await expect(page.getByTestId('ticket-reason')).toContainText('halted');
      await sellSide(page);
      await expect(reviewButton(page)).toBeDisabled();
      await expect(page.getByTestId('ticket-reason')).toContainText('halted');

      await control('/instrument', { symbol: 'MSFT', status: 'SELL_ONLY' });
      await page.goto('/instruments/MSFT');
      await enterQty(page, '1');
      await expect(reviewButton(page)).toBeDisabled();
      await expect(page.getByTestId('ticket-reason')).toContainText('cannot buy more');
      await sellSide(page);
      await readyToReview(page, '1'); // selling is allowed
      await expect(page.getByTestId('ticket-reason')).toHaveAttribute('data-reason', 'none');
    } finally {
      await control('/instrument', { symbol: 'MSFT', status: 'ACTIVE' });
    }
    await page.goto('/instruments/MSFT'); // control: ACTIVE and open
    await enterQty(page, '1');
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
  });
});

test.describe('7. not enough cash or shares', () => {
  test('disabled with the reason; forced through the API they are REJECTED, nothing moves, and the books reconcile', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');

    await enterQty(page, '100'); // 100 x 190 is more than the 10,000 in the account
    await expect(reviewButton(page)).toBeDisabled({ timeout: 10_000 });
    await expect(page.getByTestId('ticket-reason')).toContainText('did not have enough cash');
    await expect(page.getByTestId('estimate-cash-after')).toContainText('−'); // (a real minus sign) shown as what it would have been

    await sellSide(page);
    await expect(page.getByTestId('ticket-reason')).toContainText('do not own any AAPL');
    await expect(reviewButton(page)).toBeDisabled();

    const before = await apiGet<{ cash: string }>(context, '/v1/account');
    const buy = await placeOrder(context, { ...BUY_AAPL_10, qty: '100' });
    expect(buy).toMatchObject({ status: 'REJECTED', rejectCode: 'INSUFFICIENT_BUYING_POWER' });
    const sell = await placeOrder(context, {
      ...BUY_AAPL_10,
      side: 'SELL',
      qty: '1',
      referencePrice: '189.95',
    });
    expect(sell).toMatchObject({ status: 'REJECTED', rejectCode: 'INSUFFICIENT_POSITION' });
    expect((await apiGet<{ cash: string }>(context, '/v1/account')).cash).toBe(before.cash);

    // and a holder who asks to sell more than they hold is told so
    await buySide(page);
    await buyAndWait(page, '5');
    await page.getByTestId('result-close').click();
    await sellSide(page);
    await enterQty(page, '6');
    await expect(page.getByTestId('ticket-reason')).toContainText('do not own enough shares', {
      timeout: 10_000,
    });
    await expect(reviewButton(page)).toBeDisabled();
    await enterQty(page, '5'); // control: exactly what is held is allowed
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });

    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('8. PRICE_MOVED', () => {
  test('the price moves between the estimate and Confirm: rejected, the new price is shown, nothing is resubmitted, re-confirm is required', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const posts = recordOrderPosts(page);
    await review(page, '10');
    await setQuote('AAPL', '192.95', '193.00'); // 1.58% above the 190.00 the order was reviewed at
    await page.getByTestId('confirm-button').click();

    await expect(page.getByTestId('result-rejected')).toBeVisible();
    await expect(page.getByTestId('result-reason')).toContainText('moved more than 1% against you');
    await expect(page.getByTestId('result-rejected')).toContainText('no money moved');
    await expect(page.getByTestId('price-moved-new-price')).toHaveText('193.00', {
      timeout: 10_000,
    });
    await page.screenshot({ path: `${SHOTS}/ticket-price-moved-1280.png` });
    await page.waitForTimeout(1500); // nothing is resubmitted by itself
    expect(posts.keys).toHaveLength(1);
    expect(await counts(email)).toEqual({ orders: '1', executions: '0' });
    expect((await apiGet<{ cash: string }>(context, '/v1/account')).cash).toMatch(/^10000(\.0+)?$/);

    await page.getByTestId('review-again').click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByTestId('estimate-price')).toHaveText('193.04', { timeout: 10_000 });
    expect(posts.keys).toHaveLength(1);
    await reviewButton(page).click(); // the user must confirm again
    await expect(page.getByTestId('review-summary')).toContainText('193.04');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-price')).toHaveText('193.04');
    expect(posts.keys).toHaveLength(2);
    expect(posts.keys[1]).not.toBe(posts.keys[0]); // a definitive answer ended the first attempt
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('9. two users', () => {
  test("B cannot see or reach A's orders, and A's ticket works while B has an empty account", async ({
    page,
    browser,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await buyAndWait(page, '1');
    const a = await apiGet<{ orders: { id: string }[] }>(page.context(), '/v1/orders');
    expect(a.orders).toHaveLength(1);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await register(pageB);
    await pageB.goto('/orders');
    await expect(pageB.getByTestId('empty-state')).toContainText('No orders yet');
    const b = await apiGet<{ orders: unknown[] }>(ctxB, '/v1/orders');
    expect(b.orders).toEqual([]);
    const res = await ctxB.request.get(`http://localhost:4100/v1/orders/${a.orders[0]!.id}`, {
      headers: { Origin: 'http://localhost:3100' },
    });
    expect(res.status()).toBe(404);
    await pageB.goto('/instruments/AAPL');
    await expect(pageB.getByTestId('position-none')).toBeVisible();
    await ctxB.close();
  });
  // Shared-IP login limits through the real proxy: apps/web/e2e/proxy-ip.spec.ts (T1).
});

test.describe('10. accessibility and the keyboard', () => {
  async function serious(page: Page): Promise<string[]> {
    const r = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    return r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  }

  test('axe: search results, instrument page, every ticket step (estimate, review, retry, filled, rejected, price moved)', async ({
    page,
  }) => {
    await register(page);
    await page.keyboard.press('/');
    await page.keyboard.type('AAPL');
    await expect(page.getByTestId('search-option').first()).toBeVisible();
    expect(await serious(page), 'search results').toEqual([]);

    await page.goto('/instruments/AAPL');
    expect(await serious(page), 'instrument').toEqual([]);
    await readyToReview(page, '10');
    expect(await serious(page), 'ticket estimate').toEqual([]);
    await reviewButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(await serious(page), 'ticket review').toEqual([]);

    // retry notice
    let first = true;
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() === 'POST' && first) {
          first = false;
          await route.abort('connectionrefused');
        } else await route.continue();
      },
    );
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('retry-notice')).toBeVisible();
    expect(await serious(page), 'ticket retry').toEqual([]);

    // price moved
    await setQuote('AAPL', '192.95', '193.00');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-rejected')).toBeVisible();
    expect(await serious(page), 'ticket rejected').toEqual([]);
    await page.getByTestId('review-again').click();
    await readyToReview(page, '10');
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(await serious(page), 'ticket filled').toEqual([]);
  });

  test('keyboard only: from the search box to a filled order, and the dialog manages focus', async ({
    page,
  }) => {
    await register(page);
    await page.keyboard.press('/');
    await page.keyboard.type('aapl');
    await expect(page.getByTestId('search-option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/instruments/AAPL');

    const focused = (id: string) => page.locator(`[data-testid="${id}"]:focus`);
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab');
      if ((await focused('ticket-qty').count()) === 1) break;
    }
    await expect(focused('ticket-qty')).toHaveCount(1);
    await page.keyboard.type('10');
    await expect(page.getByTestId('estimate-price')).toBeVisible({ timeout: 10_000 });
    await expect(reviewButton(page)).toBeEnabled();
    await page.keyboard.press('Tab'); // M8: the Max button sits between the quantity and Review
    await expect(focused('ticket-max')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(focused('review-button')).toHaveCount(1);
    await page.keyboard.press('Enter');

    // focus moves into the dialog (to its heading), and Tab stays inside it
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('#ticket-dialog-title:focus')).toHaveCount(1);
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      // focus is inside the dialog, or on the document itself (the page behind a modal dialog cannot take focus)
      expect(
        await page.evaluate(() => {
          const el = document.activeElement;
          return el === null || el === document.body || el.closest('dialog') !== null;
        }),
      ).toBe(true);
    }
    // Escape closes the review and gives focus back to the page
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(reviewButton(page)).toBeEnabled();

    await reviewButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('confirm-button')).toBeEnabled();
    await page.getByTestId('confirm-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.locator('#ticket-dialog-title:focus')).toHaveCount(1);
    await expect(page.getByTestId('result-filled')).toHaveAttribute('aria-live', 'polite');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByTestId('position-qty')).toHaveText('10');
  });

  test('fits a 375 px phone with no sideways scroll, and the controls are touch sized', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await register(page);
    await page.goto('/instruments/AAPL');
    await readyToReview(page, '10');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await reviewButton(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `${SHOTS}/ticket-375.png`, fullPage: true });
    await reviewButton(page).click();
    await expect(dialog(page)).toBeVisible();
    const dbox = await dialog(page).boundingBox();
    expect((dbox?.x ?? -1) >= 0 && (dbox?.x ?? 0) + (dbox?.width ?? 999) <= 375).toBe(true);
    await page.screenshot({ path: `${SHOTS}/ticket-review-375.png` });
  });

  test('the quantity field takes digits and one dot only (M8): letters, signs and exponents never get in, a paste that is not a plain decimal is refused; a fraction on a whole-share stock is kept and blocked with the step message', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    const qty = page.getByTestId('ticket-qty');
    await qty.click();
    await page.keyboard.type('1a-e5+ 0');
    await expect(qty).toHaveValue('150');
    await qty.fill('');
    const paste = (text: string) =>
      qty.evaluate((el, t) => {
        const dt = new DataTransfer();
        dt.setData('text', t);
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      }, text);
    await paste('1e5'); // an exponent is refused
    await expect(qty).toHaveValue('');
    await paste('-5');
    await expect(qty).toHaveValue('');
    await qty.fill('1.5'); // a decimal is allowed into the field, then blocked for a whole-share instrument
    await expect(qty).toHaveValue('1.5');
    await expect(page.getByTestId('ticket-reason')).toContainText('steps of 1');
    await expect(reviewButton(page)).toBeDisabled();
    await qty.fill('');
    await qty.fill('99999999');
    await expect(qty).toHaveValue('9999999');
    await expect(reviewButton(page)).toBeDisabled();
    await expect(page.getByTestId('ticket-reason')).toContainText('most you can order');
  });
});

test.describe('11. security', () => {
  test('a whole buy leaves no CSP violation, no console error, nothing in storage and no token in script-readable cookies', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __csp: string[] }).__csp ??= [];
        (window as unknown as { __csp: string[] }).__csp.push(
          `${e.violatedDirective} ${e.blockedURI}`,
        );
      });
    });
    await register(page);
    await page.goto('/instruments/AAPL');
    await buyAndWait(page, '1');
    await page.getByTestId('result-close').click();

    const state = await page.evaluate(() => ({
      csp: (window as unknown as { __csp?: string[] }).__csp ?? [],
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookie: document.cookie,
    }));
    expect(state.csp).toEqual([]);
    expect(state.local).toEqual([]);
    expect(state.session).toEqual([]);
    expect(state.cookie).toBe(''); // the session cookie is HttpOnly
    expect(problems).toEqual([]);
  });

  test('the instrument page is served with the nonce CSP and no-store', async ({ page }) => {
    await register(page);
    const res = await page.goto('/instruments/AAPL');
    const csp = res?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res?.headers()['cache-control']).toContain('no-store');
  });
});

test.describe('401 mid-order', () => {
  test('a session that has expired sends the user to sign in and brings them back to the same instrument', async ({
    page,
    context,
  }) => {
    const { email, password } = await register(page);
    await page.goto('/instruments/AAPL');
    await review(page, '1');
    await context.clearCookies(); // the session is gone
    await page.getByTestId('confirm-button').click();
    await page.waitForURL(/\/login\?.*next=%2Finstruments%2FAAPL/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/instruments/AAPL');
    expect(await counts(email)).toEqual({ orders: '0', executions: '0' });
  });
});
