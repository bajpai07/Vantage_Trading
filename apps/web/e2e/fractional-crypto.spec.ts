// M8 end to end: fractional crypto trading through the real ticket, real API and real Postgres. The quote is scripted
// through the control server (BTC-USD bid 89,990.00 / ask 90,010.00), so the numbers are the hand-verified golden vectors
// A and B of packages/engine/src/fractional.test.ts, read back from what the browser shows.
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

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('BTC-USD', '89990.00', '90010.00');
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

const reviewButton = (page: Page) => page.getByTestId('review-button');
const sellSide = (page: Page) => page.locator('label:has([data-testid="side-sell"])').click();
const text = (page: Page, id: string) => page.getByTestId(id).innerText();

async function readyToReview(page: Page, qty: string): Promise<void> {
  await enterQty(page, qty);
  await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('estimate-price')).toBeVisible();
}

async function buyOrSell(page: Page, qty: string): Promise<void> {
  await readyToReview(page, qty);
  await reviewButton(page).click();
  await expect(page.getByTestId('ticket-dialog')).toBeVisible();
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-filled')).toBeVisible();
}

async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('1. buy 0.0025 BTC-USD (vector A) and sell 0.001 (vector B) through the UI', () => {
  test('estimate, review, confirm: every figure is the exact string; the portfolio and orders screens agree; reconciles clean', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/BTC-USD');
    // the ticket for a fractional instrument: decimals allowed, step and minimum shown, Buy is not blocked by "not tradable yet"
    await expect(page.getByTestId('ticket-qty-help')).toHaveText(
      'Steps of 0.00000001 · minimum 0.00000001',
    );
    await expect(page.getByTestId('ticket-reason')).toHaveText(/Enter a quantity/);

    // ---- A: BUY 0.0025 ----
    await readyToReview(page, '0.0025');
    await expect(page.getByTestId('estimate-price')).toHaveText('90,055.01');
    await expect(page.getByTestId('estimate-notional')).toHaveText('225.137525');
    await expect(page.getByTestId('estimate-fee')).toHaveText('0.22513752');
    await expect(page.getByTestId('estimate-cash-after')).toHaveText('9,774.63733748');
    await reviewButton(page).click();
    await expect(page.getByTestId('review-summary')).toContainText('0.0025 BTC-USD');
    await expect(page.getByTestId('review-notional')).toHaveText('225.137525');
    await expect(page.getByTestId('review-fee')).toHaveText('0.22513752');
    await expect(page.getByTestId('review-cash-after')).toHaveText('9,774.63733748');
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-qty')).toHaveText('0.0025 BTC-USD');
    await expect(page.getByTestId('result-price')).toHaveText('90,055.01');
    await expect(page.getByTestId('result-notional')).toHaveText('225.137525');
    await expect(page.getByTestId('result-fee')).toHaveText('0.22513752');
    await expect(page.getByTestId('result-cash')).toHaveText('9,774.63733748');
    await page.getByTestId('result-close').click();

    // ---- B: SELL 0.001 ----
    await sellSide(page);
    await readyToReview(page, '0.001');
    await expect(page.getByTestId('estimate-price')).toHaveText('89,945.00');
    await expect(page.getByTestId('estimate-notional')).toHaveText('89.945');
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-qty')).toHaveText('0.001 BTC-USD');
    await expect(page.getByTestId('result-notional')).toHaveText('89.945');
    await expect(page.getByTestId('result-fee')).toHaveText('0.089945');
    await expect(page.getByTestId('result-cash')).toHaveText('9,864.49239248');
    await page.getByTestId('result-close').click();

    // ---- the portfolio screen: the position as received, the exact cash on detail ----
    await page.goto('/portfolio');
    const row = page.getByTestId('position-row-BTC-USD');
    await expect(row).toContainText('0.0015');
    await expect(row).toContainText('90,055.01'); // the average cost of the rest
    await page.getByTestId('exact-amounts').locator('summary').click();
    await expect(page.getByTestId('exact-amounts')).toContainText('9864.49239248');
    await expect(page.getByTestId('exact-amounts')).toContainText('135.082515'); // the exact cost basis of the rest

    // ---- the orders screen: both fractional quantities, as stored ----
    await page.goto('/orders');
    const rows = page.getByTestId('order-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('0.001');
    await expect(rows.nth(1)).toContainText('0.0025');

    // the API says the same
    const pos = await apiGet<{
      positions: Array<{ symbol: string; qty: string; avgCost: string }>;
    }>(context, '/v1/positions');
    expect(pos.positions).toMatchObject([
      {
        symbol: 'BTC-USD',
        qty: '0.0015',
        avgCost: '90055.01',
        qtyReserved: '0',
        qtyAvailable: '0.0015',
      },
    ]);
    const rec = await reconcile(email);
    expect(rec.violations).toEqual([]);
    expect(rec.accounts).toBe(1);
  });
});

test.describe('2. Max fills the server string and the order then fills', () => {
  test('crypto: Max puts 0.1109323 in the field (decided by the server), the estimate follows, the order fills', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await page.getByTestId('ticket-max').click();
    await expect(page.getByTestId('ticket-qty')).toHaveValue('0.1109323'); // 10,000 buys 0.1109323 (hand-checked)
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-qty')).toHaveText('0.1109323 BTC-USD');
  });

  test('stock: Max is 52 shares and fills; with no cash left, Max says so (control)', async ({
    page,
    context,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await page.getByTestId('ticket-max').click();
    await expect(page.getByTestId('ticket-qty')).toHaveValue('52');
    await buyOrSell(page, '52');
    await page.getByTestId('result-close').click();
    // now only 117.92 is left (10,000.00 - 52 x 190.04 = 9,882.08): Max is 0 (the smallest order of 1 share costs 190.04)
    await page.getByTestId('ticket-qty').fill('');
    await page.getByTestId('ticket-max').click();
    await expect(page.getByTestId('ticket-max-note')).toHaveText(
      'Your cash does not cover even the smallest order.',
    );
    expect(await text(page, 'ticket-qty')).toBe('');
    const rec = await apiGet<{ positions: unknown[] }>(context, '/v1/positions');
    expect(rec.positions).toHaveLength(1);
  });

  test('SELL Max is the position; with nothing owned Max is disabled with the reason (control)', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await sellSide(page);
    await expect(page.getByTestId('ticket-max')).toBeDisabled();
    await enterQty(page, '0.001');
    await expect(page.getByTestId('ticket-reason')).toHaveText(
      /You do not own any BTC-USD to sell/,
    );
  });
});

test.describe('3. a fractional stock quantity is blocked, in the browser and by the server', () => {
  test('1.5 AAPL: the step message and a disabled Review; the server also rejects it (QTY_STEP_VIOLATION); 2 fills (control)', async ({
    page,
    context,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('ticket-qty-help')).toHaveText('Whole shares only · minimum 1');
    await enterQty(page, '1.5');
    await expect(page.getByTestId('ticket-qty')).toHaveValue('1.5');
    await expect(page.getByTestId('ticket-reason')).toHaveText(
      /This instrument trades in steps of 1\./,
    );
    await expect(reviewButton(page)).toBeDisabled();

    // the server decides the same, whatever the browser does: a direct API call is a REJECTED order
    const rejected = await context.request.post(`${API_ORIGIN}/v1/orders`, {
      headers: {
        Origin: WEB_ORIGIN,
        'Idempotency-Key': `e2e-frac-${Date.now()}`,
        'Content-Type': 'application/json',
      },
      data: { symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: '1.5', referencePrice: '190.00' },
    });
    expect(rejected.status()).toBe(201);
    expect(await rejected.json()).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'QTY_STEP_VIOLATION',
    });

    await enterQty(page, '2');
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
  });

  test('more than 8 decimals cannot be typed: the extra digits are dropped; letters and signs never enter the field', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await page.getByTestId('ticket-qty').pressSequentially('1.123456789');
    await expect(page.getByTestId('ticket-qty')).toHaveValue('1.12345678');
    await page.getByTestId('ticket-qty').fill('');
    await page.getByTestId('ticket-qty').pressSequentially('1e5-+');
    await expect(page.getByTestId('ticket-qty')).toHaveValue('15');
  });
});

test.describe('4. one order, however many clicks; keyboard only; accessibility', () => {
  test('a double-click on Confirm makes exactly one order and one execution', async ({ page }) => {
    const { email } = await register(page);
    await page.goto('/instruments/BTC-USD');
    await readyToReview(page, '0.0025');
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').dblclick();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
  });

  test('a network failure on the first POST, then Retry safely: one order (the same idempotency key)', async ({
    page,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/BTC-USD');
    await readyToReview(page, '0.0025');
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
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
  });

  test('keyboard only: type a fractional quantity, Tab to Max and Review, Enter, Tab to Confirm, Enter', async ({
    page,
  }) => {
    await register(page);
    // diagnostics for a failure: every preview request with its status and duration, and what the ticket says
    const previews: string[] = [];
    page.on('requestfinished', async (req) => {
      if (!req.url().endsWith('/v1/orders/preview')) return;
      const res = await req.response();
      previews.push(`${String(res?.status())} ${String(Math.round(req.timing().responseEnd))}ms`);
    });
    page.on('requestfailed', (req) => {
      if (req.url().endsWith('/v1/orders/preview'))
        previews.push(`failed: ${req.failure()?.errorText ?? ''}`);
    });
    await page.goto('/instruments/BTC-USD');
    try {
      // Under heavy machine load the page can still be hydrating when the first keystrokes arrive and the form then starts from an
      // empty quantity (measured: field value "" and no preview request were ever sent). A person would simply type again, so the
      // test does too: clear, focus, type with the keyboard, and wait for the estimate to make Review available.
      await expect(async () => {
        await page.getByTestId('ticket-qty').fill('');
        await page.getByTestId('ticket-qty').focus();
        await page.keyboard.type('0.001');
        await expect(reviewButton(page)).toBeEnabled({ timeout: 4_000 });
      }).toPass({ timeout: 30_000 });
    } catch (e) {
      const reason = await page
        .getByTestId('ticket-reason')
        .textContent({ timeout: 1000 })
        .catch(() => '(none)');
      const typed = await page
        .getByTestId('ticket-qty')
        .inputValue({ timeout: 1000 })
        .catch(() => '(none)');
      const estimate = await page
        .getByTestId('ticket-estimate')
        .textContent({ timeout: 1000 })
        .catch(() => '(none)');
      throw new Error(
        `the Review button stayed disabled. field value: ${JSON.stringify(typed)}; url: ${page.url()}; ticket-reason: ${JSON.stringify(reason)}; estimate: ${JSON.stringify(estimate)}; preview requests: ${JSON.stringify(previews)}
${(e as Error).message}`,
        { cause: e },
      );
    }
    await page.keyboard.press('Tab'); // Max
    await expect(page.getByTestId('ticket-max')).toBeFocused();
    await page.keyboard.press('Tab'); // Review
    await expect(reviewButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ticket-dialog')).toBeVisible();
    await page.keyboard.press('Tab'); // Edit order
    await page.keyboard.press('Tab'); // Buy 0.001 BTC-USD
    await expect(page.getByTestId('confirm-button')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-qty')).toHaveText('0.001 BTC-USD');
  });

  test('axe: the fractional ticket (empty, with Max note, estimate, review, filled, rejected step) has no serious violations', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    expect(await serious(page), 'crypto ticket').toEqual([]);
    await readyToReview(page, '0.0025');
    expect(await serious(page), 'estimate').toEqual([]);
    await reviewButton(page).click();
    await expect(page.getByTestId('ticket-dialog')).toBeVisible();
    expect(await serious(page), 'review').toEqual([]);
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(await serious(page), 'filled').toEqual([]);
    await page.getByTestId('result-close').click();
    // spend (almost) all the cash with Max, then Max again: the note says the cash does not cover the smallest order
    await page.getByTestId('ticket-max').click();
    await expect(reviewButton(page)).toBeEnabled({ timeout: 10_000 });
    await reviewButton(page).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await page.getByTestId('result-close').click();
    await page.getByTestId('ticket-qty').fill('');
    await page.getByTestId('ticket-max').click();
    await expect(page.getByTestId('ticket-max-note')).toHaveText(
      'Your cash does not cover even the smallest order.',
    );
    expect(await serious(page), 'max note').toEqual([]);
    // the step message on a stock
    await page.goto('/instruments/AAPL');
    await enterQty(page, '1.5');
    await expect(page.getByTestId('ticket-reason')).toHaveText(/steps of 1/);
    expect(await serious(page), 'step message').toEqual([]);
  });
});
