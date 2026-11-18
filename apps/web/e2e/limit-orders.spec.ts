// M8b-1 end to end: LIMIT orders through the real ticket, orders and portfolio screens, the real API, the matcher and Postgres.
// The quote is scripted through the control server (BTC-USD bid 89,990.00 / ask 90,010.00 unless a test moves it); the matcher runs
// inside the e2e API every 300 ms. Numbers are the hand-verified vectors E, F and H of packages/engine/src/limit-orders.test.ts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  API_ORIGIN,
  WEB_ORIGIN,
  apiGet,
  control,
  counts,
  enterQty,
  reconcile,
  register,
  setQuote,
} from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const BASE = { bid: '89990.00', ask: '90010.00' };

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('BTC-USD', BASE.bid, BASE.ask);
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

const reviewButton = (page: Page) => page.getByTestId('review-button');
const dialog = (page: Page) => page.getByTestId('ticket-dialog');

async function limitForm(page: Page, qty: string, limit: string): Promise<void> {
  await page.locator('label:has([data-testid="kind-limit"])').click();
  await enterQty(page, qty);
  await page.getByTestId('ticket-limit').fill(limit);
  await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('estimate-mode')).toBeVisible();
}

/** Places a resting limit BUY 0.0025 @ 89,900.00 through the UI and returns once the "Order placed" result is shown. */
async function placeResting(page: Page): Promise<void> {
  await page.goto('/instruments/BTC-USD');
  await limitForm(page, '0.0025', '89900.00');
  await reviewButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-accepted')).toBeVisible();
}

async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

type Portfolio = { exact: { cash: string; reservedUsd: string; equity: string } };

test.describe('1. a resting limit BUY: review shows the reserve, Open orders lists it, Reserved shows on the portfolio, Cancel restores the cash exactly', () => {
  test('place, see it rest, see the reserve, cancel, cash is 10,000.00 again; reconciles clean', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('ticket-limit')).toHaveCount(0); // market by default
    await limitForm(page, '0.0025', '89900.00');

    // the estimate: rests, with the reserve (R = 224.75 + 0.22475)
    await expect(page.getByTestId('estimate-mode')).toHaveText(
      'Rests until filled, cancelled or expired',
    );
    await expect(page.getByTestId('estimate-reserve')).toHaveText('224.97475');
    await expect(page.getByTestId('estimate-cash-after')).toHaveText('9,775.02525');
    await reviewButton(page).click();
    await expect(page.getByTestId('review-reserve')).toHaveText('224.97475');
    await expect(page.getByTestId('review-mode')).toHaveText(
      'Resting until filled, cancelled or expired.',
    );
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    await expect(page.getByTestId('result-reserved')).toHaveText('224.97475');
    await expect(page.getByTestId('result-limit')).toHaveText('89,900.00');
    await page.getByTestId('result-close').click();

    // the orders screen: under Open orders with what is held
    await page.goto('/orders');
    const row = page.getByTestId('open-order-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('BTC-USD');
    await expect(page.getByTestId('open-order-held')).toHaveText('224.97475 cash');
    await expect(page.getByTestId('open-order-type')).toContainText('Limit 89,900.00');
    await expect(page.getByTestId('order-row').first().getByTestId('status-chip')).toHaveText(
      /Accepted/,
    );

    // the portfolio: Reserved next to Cash; the exact amounts on detail
    await page.goto('/portfolio');
    await expect(page.getByTestId('metric-reserved')).toContainText('224.97');
    await page.getByTestId('exact-amounts').locator('summary').click();
    await expect(page.getByTestId('exact-amounts')).toContainText('224.97475');
    await expect(page.getByTestId('exact-amounts')).toContainText('9775.02525');
    await expect(page.getByTestId('equity-identity')).toContainText('cash + reserved');
    const p1 = await apiGet<Portfolio>(context, '/v1/portfolio');
    expect(p1.exact).toMatchObject({
      cash: '9775.02525',
      reservedUsd: '224.97475',
      equity: '10000.00',
    });

    // cancel it from the orders screen
    await page.goto('/orders');
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('cancel-notice')).toContainText(
      'Cancelled. 224.97475 is back in your cash.',
    );
    await expect(page.getByTestId('open-orders-empty')).toBeVisible();
    await expect(page.getByTestId('order-row').first().getByTestId('status-chip')).toHaveText(
      /Cancelled/,
    );
    const p2 = await apiGet<Portfolio>(context, '/v1/portfolio');
    expect(p2.exact).toMatchObject({ cash: '10000.00', reservedUsd: '0.00' }); // restored exactly
    const rec = await reconcile(email);
    expect(rec.violations).toEqual([]);
  });
});

test.describe('2. a marketable limit fills immediately; a resting one is filled by the matcher', () => {
  test('quote 89,880.00 / 89,899.00 and a limit of 89,900.00: "Fills now", filled at the limit 89,900.00 (vector F)', async ({
    page,
  }) => {
    await register(page);
    await setQuote('BTC-USD', '89880.00', '89899.00');
    await page.goto('/instruments/BTC-USD');
    await limitForm(page, '0.0025', '89900.00');
    await expect(page.getByTestId('estimate-mode')).toContainText('Fills now at about 89,900.00');
    await reviewButton(page).click();
    await expect(page.getByTestId('review-mode')).toContainText('Fills now at about 89,900.00');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-price')).toHaveText('89,900.00');
    await expect(page.getByTestId('result-notional')).toHaveText('224.75');
    await expect(page.getByTestId('result-fee')).toHaveText('0.22475');
    await expect(page.getByTestId('result-cash')).toHaveText('9,775.02525');
  });

  test('a resting BUY fills when the quote moves to 89,830.00 / 89,850.00: Open orders empties, History shows Filled, cash 9,775.03793768 (vector E)', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await placeResting(page);
    await page.goto('/orders');
    await expect(page.getByTestId('open-order-row')).toHaveCount(1);
    await setQuote('BTC-USD', '89830.00', '89850.00'); // the matcher evaluates this quote within a few hundred ms
    await expect(page.getByTestId('open-orders-empty')).toBeVisible({ timeout: 20_000 }); // the page polls every 3 s
    const first = page.getByTestId('order-row').first();
    await expect(first.getByTestId('status-chip')).toHaveText(/Filled/);
    await expect(first.getByTestId('order-result')).toContainText('89,894.93');
    const p = await apiGet<Portfolio>(context, '/v1/portfolio');
    expect(p.exact).toMatchObject({
      cash: '9775.03793768',
      reservedUsd: '0.00',
      equity: expect.stringMatching(/^99/),
    });
    expect((await reconcile(email)).violations).toEqual([]);
  });
});

test.describe('3. one order however many clicks; keyboard only; accessibility', () => {
  test('a double-click on Confirm makes one order; a double-click on Cancel cancels once', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/BTC-USD');
    await limitForm(page, '0.0025', '89900.00');
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').dblclick();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    expect(await counts(email)).toEqual({ orders: '1', executions: '0' });
    await page.getByTestId('result-close').click();

    await page.goto('/orders');
    await page.getByTestId('cancel-button').dblclick();
    await expect(page.getByTestId('open-orders-empty')).toBeVisible();
    const orders = await apiGet<{ orders: Array<{ status: string }> }>(context, '/v1/orders');
    expect(orders.orders.map((o) => o.status)).toEqual(['CANCELLED']);
    const p = await apiGet<Portfolio>(context, '/v1/portfolio');
    expect(p.exact).toMatchObject({ cash: '10000.00', reservedUsd: '0.00' }); // released once, not twice
    expect((await reconcile(email)).violations).toEqual([]);
  });

  test('a network failure on the first POST, then Retry safely: one order (the same key)', async ({
    page,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/BTC-USD');
    await limitForm(page, '0.0025', '89900.00');
    await reviewButton(page).click();
    const keys: string[] = [];
    let first = true;
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        keys.push(route.request().headers()['idempotency-key'] ?? '');
        if (first) {
          first = false;
          return route.abort('connectionrefused');
        }
        return route.continue();
      },
    );
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('retry-notice')).toBeVisible();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await counts(email)).toEqual({ orders: '1', executions: '0' });
  });

  test('keyboard only: choose Limit, type the quantity and the limit price, Review, Confirm', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await page.getByTestId('kind-limit').focus();
    await page.keyboard.press('Space'); // selects the focused radio
    await expect(page.getByTestId('ticket-limit')).toBeVisible();
    await page.getByTestId('ticket-qty').focus();
    await page.keyboard.type('0.0025');
    await page.keyboard.press('Tab'); // Max (when it is enabled), then the limit price
    if (!(await page.getByTestId('ticket-limit').evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press('Tab');
    }
    await expect(page.getByTestId('ticket-limit')).toBeFocused();
    await page.keyboard.type('89900.00');
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
    await page.keyboard.press('Tab'); // time in force
    await expect(page.getByTestId('ticket-tif')).toBeFocused();
    await page.keyboard.press('Tab'); // Review
    await expect(reviewButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Tab'); // Edit order
    await page.keyboard.press('Tab'); // Confirm
    await expect(page.getByTestId('confirm-button')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('result-accepted')).toBeVisible();
  });

  test('a limit price that is not a multiple of the tick is blocked with the tick message; the server also rejects it (TICK_VIOLATION)', async ({
    page,
    context,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await page.locator('label:has([data-testid="kind-limit"])').click();
    await enterQty(page, '0.0025');
    await page.getByTestId('ticket-limit').fill('89900.005');
    await expect(page.getByTestId('ticket-reason')).toContainText('multiple of 0.01');
    await expect(reviewButton(page)).toBeDisabled();
    const r = await context.request.post(`${API_ORIGIN}/v1/orders`, {
      headers: {
        Origin: WEB_ORIGIN,
        'Idempotency-Key': `e2e-tick-${Date.now()}`,
        'Content-Type': 'application/json',
      },
      data: {
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'LIMIT',
        qty: '0.0025',
        limitPrice: '89900.005',
      },
    });
    expect(await r.json()).toMatchObject({ status: 'REJECTED', rejectCode: 'TICK_VIOLATION' });
    await page.getByTestId('ticket-limit').fill('89900.01');
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
  });

  test('axe: the limit ticket (empty, estimate, review, resting result), the orders page with an open order and the portfolio with a reserve', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await page.locator('label:has([data-testid="kind-limit"])').click();
    expect(await serious(page), 'limit ticket').toEqual([]);
    await limitForm(page, '0.0025', '89900.00');
    expect(await serious(page), 'limit estimate').toEqual([]);
    await reviewButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(await serious(page), 'limit review').toEqual([]);
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    expect(await serious(page), 'resting result').toEqual([]);
    await page.getByTestId('result-close').click();
    await page.goto('/orders');
    await expect(page.getByTestId('open-order-row')).toHaveCount(1);
    expect(await serious(page), 'open orders').toEqual([]);
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('cancel-notice')).toContainText('Cancelled.');
    expect(await serious(page), 'cancelled notice').toEqual([]);
    await page.goto('/instruments/BTC-USD');
    await limitForm(page, '0.001', '89900.00');
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    await page.goto('/portfolio');
    await expect(page.getByTestId('metric-reserved')).toBeVisible();
    expect(await serious(page), 'portfolio with a reserve').toEqual([]);
  });
});
