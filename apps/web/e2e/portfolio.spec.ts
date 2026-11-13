// Portfolio screen end to end: register, orders placed through the real API, valuations, freshness badges, the
// incomplete notice, polling refresh, and the FIXTURE banner. The API runs with an injected clock (Tuesday
// 2026-11-10 10:00 New York, market open) so quote times are deterministic: a quote is "900 s old" = 14:45 UTC.
import { expect, test } from '@playwright/test';
import { BUY_AAPL_10, clearQuote, control, placeOrder, register, setQuote } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const resetMarket = async (): Promise<void> => {
  await control('/clock', { iso: OPEN });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
};

test.beforeEach(resetMarket);

test.describe('1. register lands on an empty portfolio', () => {
  test('10,000.00 cash, equity 10,000.00, the FIXTURE banner and the virtual-money notice', async ({
    page,
  }) => {
    await register(page);
    await expect(page.getByTestId('metric-cash')).toContainText('10,000.00');
    await expect(page.getByTestId('metric-equity')).toContainText('10,000.00');
    await expect(page.getByTestId('metric-total-return')).toContainText('0.00');
    await expect(page.getByTestId('empty-state')).toContainText('No positions yet');
    await expect(page.getByTestId('feed-banner')).toHaveText(
      'Simulated market data — not real prices',
    );
    await expect(page.getByTestId('virtual-money-notice')).toContainText(
      'Virtual money — not real trading',
    );
    await expect(page.getByTestId('incomplete-notice')).toHaveCount(0);
    await page.screenshot({
      path: '../../docs/phase-reports/m6a/portfolio-empty-1280.png',
      fullPage: true,
    });
  });

  test('the banner is persistent and non-dismissible: it is on the login page too, with no close control', async ({
    page,
  }) => {
    await page.goto('/login');
    const banner = page.getByTestId('feed-banner');
    await expect(banner).toHaveText('Simulated market data — not real prices');
    await expect(banner.getByRole('button')).toHaveCount(0);
    await page.reload();
    await expect(banner).toBeVisible();
    await page.screenshot({ path: '../../docs/phase-reports/m6a/login-1280.png' });
  });
});

test.describe('2. a position placed through the API, with the right strings, badge and as-of time', () => {
  test('vector A: BUY 10 AAPL, the bid moves to 195.00: cash 8,099.60, value 1,950.00, +49.60, equity 10,049.60', async ({
    page,
    context,
  }) => {
    await register(page);
    const order = await placeOrder(context, BUY_AAPL_10);
    expect(order).toMatchObject({
      status: 'FILLED',
      execution: { price: '190.04', notional: '1900.40' },
    });
    await setQuote('AAPL', '195.00', '195.05');
    await page.reload();

    const row = page.getByTestId('position-row-AAPL');
    await expect(row).toBeVisible();
    await expect(row.locator('td').nth(0)).toHaveText('10'); // qty
    await expect(row.locator('td').nth(1)).toHaveText('190.04'); // avg cost
    await expect(row.getByTestId('mark')).toContainText('195.00');
    await expect(row.getByTestId('mark-basis')).toHaveText('BID');
    await expect(row.getByTestId('market-value')).toHaveText('1,950.00');
    await expect(row.getByTestId('unrealised')).toContainText('+49.60');
    await expect(row.getByTestId('unrealised')).toHaveAttribute('data-direction', 'up');
    await expect(row.getByTestId('unrealised')).toContainText('▲');
    await expect(row.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'DELAYED');
    await expect(row.getByTestId('as-of')).toHaveText('2026-11-10 14:45 UTC');

    await expect(page.getByTestId('metric-cash')).toContainText('8,099.60');
    await expect(page.getByTestId('metric-equity')).toContainText('10,049.60');
    await expect(page.getByTestId('metric-total-return')).toContainText('+49.60');
    await expect(page.getByTestId('metric-unrealised')).toContainText('+49.60');
    await expect(page.getByTestId('marks-as-of')).toContainText('2026-11-10 14:45:00 UTC');
    // the exact amounts are one click away, as received
    await page.getByText('Exact amounts').click();
    await expect(page.getByTestId('exact-amounts')).toContainText('10049.60');
    await page.screenshot({
      path: '../../docs/phase-reports/m6a/portfolio-position-1280.png',
      fullPage: true,
    });
  });

  test('the page refreshes itself on the poll interval: a new order and a new price appear without a reload', async ({
    page,
    context,
  }) => {
    await register(page);
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __noReload: number }).__noReload = 1; // gone if the page reloads
    });

    await placeOrder(context, BUY_AAPL_10);
    await expect(page.getByTestId('position-row-AAPL')).toBeVisible({ timeout: 15_000 }); // POLL_MS is 2 s
    await expect(page.getByTestId('metric-cash')).toContainText('8,099.60');

    await setQuote('AAPL', '196.00', '196.05');
    await expect(page.getByTestId('position-row-AAPL').getByTestId('mark')).toContainText(
      '196.00',
      {
        timeout: 15_000,
      },
    );
    await expect(page.getByTestId('position-row-AAPL').getByTestId('market-value')).toHaveText(
      '1,960.00',
    );
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload),
    ).toBe(1);
  });

  test('polling stops while the tab is hidden (no requests) and catches up at once when it is visible again', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await expect(page.getByTestId('position-row-AAPL')).toBeVisible({ timeout: 15_000 });

    let polls = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/portfolio')) polls += 1;
    });
    // control: while visible the page polls (POLL_MS is 2 s)
    await expect.poll(() => polls, { timeout: 10_000 }).toBeGreaterThan(0);

    // simulate a hidden tab
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500); // let an in-flight request finish
    const whileHidden = polls;
    await page.waitForTimeout(6000); // three poll intervals
    expect(polls).toBe(whileHidden);

    // visible again: it refreshes at once, without waiting for the next interval
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => polls, { timeout: 1500 }).toBeGreaterThan(whileHidden);
  });
});

test.describe('3. honesty: no price, stale and closed are never dressed up', () => {
  test('UNAVAILABLE quote: the position is flagged and excluded, the incomplete notice shows, total return is a dash', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await clearQuote('AAPL');
    await page.reload();

    const row = page.getByTestId('position-row-AAPL');
    await expect(row).toHaveAttribute('data-valuation', 'UNAVAILABLE');
    await expect(row.getByTestId('unavailable-flag')).toContainText(
      'No price: excluded from totals',
    );
    await expect(row.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'UNAVAILABLE');
    await expect(row.getByTestId('market-value')).toContainText('—');
    await expect(row.getByTestId('market-value')).not.toContainText('0.00');
    await expect(row.getByTestId('unrealised')).toContainText('—');
    await expect(row.getByTestId('as-of')).toHaveText('No quote');

    await expect(page.getByTestId('incomplete-alert')).toContainText('Incomplete valuation');
    await expect(page.getByTestId('incomplete-alert')).toContainText(
      '1 position has no usable price',
    );
    await expect(page.getByTestId('total-return-unavailable')).toHaveText('—not available');
    await expect(page.getByTestId('metric-total-return')).not.toContainText('0.00');
    await expect(page.getByTestId('metric-equity')).toContainText('8,099.60'); // cash only: not valued at zero, not at cost
    await expect(page.getByTestId('metric-equity')).toContainText(
      'Excludes positions without a price',
    );
    await page.screenshot({
      path: '../../docs/phase-reports/m6a/portfolio-unavailable-1280.png',
      fullPage: true,
    });

    // control: a quote brings it back and the notice goes
    await setQuote('AAPL', '195.00', '195.05');
    await page.reload();
    await expect(page.getByTestId('incomplete-notice')).toHaveCount(0);
    await expect(page.getByTestId('position-row-AAPL')).toHaveAttribute('data-valuation', 'VALUED');
    await expect(page.getByTestId('metric-total-return')).toContainText('+49.60');
  });

  test('a STALE quote is valued but labelled STALE with its own time; a fresh one is DELAYED (control)', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await setQuote('AAPL', '195.00', '195.05', { ageSeconds: 2000 });
    await page.reload();
    const row = page.getByTestId('position-row-AAPL');
    await expect(row.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'STALE');
    await expect(row.getByTestId('market-value')).toHaveText('1,950.00');
    await expect(row.getByTestId('as-of')).toHaveText('2026-11-10 14:26 UTC'); // 15:00 minus 2000 s
    await setQuote('AAPL', '195.00', '195.05');
    await page.reload();
    await expect(
      page.getByTestId('position-row-AAPL').getByTestId('freshness-badge'),
    ).toHaveAttribute('data-state', 'DELAYED');
  });

  test('a closed market is labelled CLOSED with the last bid and its time', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await control('/clock', { iso: '2026-11-10T22:00:00.000Z' }); // 17:00 New York, after the close
    await setQuote('AAPL', '195.00', '195.05');
    await page.reload();
    const row = page.getByTestId('position-row-AAPL');
    await expect(row.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'CLOSED');
    await expect(row.getByTestId('mark')).toContainText('195.00');
    await expect(row.getByTestId('as-of')).toHaveText('2026-11-10 21:45 UTC');
    await expect(row.getByTestId('freshness-badge')).not.toHaveAttribute('data-state', 'REAL_TIME');
  });

  test('a failed refresh keeps the last figures on screen, says so and shows how old they are', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await page.reload();
    await expect(page.getByTestId('position-row-AAPL')).toBeVisible();
    await page.route('**/api/v1/portfolio', (route) => route.abort('connectionrefused'));
    await expect(page.getByTestId('refresh-error')).toContainText('Could not refresh', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('refresh-error')).toContainText("We can't reach the server");
    await expect(page.getByTestId('position-row-AAPL')).toBeVisible(); // the last data stays
    await page.unroute('**/api/v1/portfolio');
    await expect(page.getByTestId('refresh-error')).toHaveCount(0, { timeout: 15_000 }); // and recovers
  });
});
