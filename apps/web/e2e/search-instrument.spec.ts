// Search and the instrument page end to end (T3): keyboard search, honest empty and error states, the quote panel with
// its freshness and the server-computed spread, status explanations, position and recent orders, polling.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  BUY_AAPL_10,
  clearQuote,
  control,
  placeOrder,
  register,
  setQuote,
  shotPath,
} from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

const search = (page: Page) => page.getByTestId('search-input');

test.describe('search', () => {
  test('type, arrow, Enter: opens the instrument; "/" focuses the box; Escape clears and closes', async ({
    page,
  }) => {
    await register(page);
    await page.keyboard.press('/');
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveAttribute('placeholder', /Search stocks, ETFs and crypto/);
    await page.keyboard.type('aapl');
    const first = page.getByTestId('search-option').first();
    await expect(first).toBeVisible();
    await expect(first).toContainText('AAPL');
    await expect(first).toContainText('XNAS'); // the exchange code is shown with the instrument type
    await expect(first).toContainText('Stock');
    await expect(search(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/instruments/AAPL');
    await expect(page.getByTestId('instrument-symbol')).toHaveText('AAPL');
    // Escape: closes the panel, then clears the text
    await page.keyboard.press('/');
    await page.keyboard.type('ms');
    await expect(page.getByTestId('search-option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search(page)).toHaveValue('');
    await expect(page.getByTestId('search-option')).toHaveCount(0);
  });

  test('"/" does not steal the key while you are typing in a field', async ({ page }) => {
    await register(page);
    await search(page).click();
    await page.keyboard.type('a/b');
    await expect(search(page)).toHaveValue('a/b');
  });

  test('no results is a normal answer, worded as one (not an error); a real ticker has results (control)', async ({
    page,
  }) => {
    await register(page);
    await search(page).fill('zzzzq9');
    await expect(page.getByTestId('search-empty')).toContainText('No stocks, ETFs or crypto match');
    await expect(page.getByTestId('search-error')).toHaveCount(0);
    await expect(page.getByTestId('search-status')).toHaveText('No results');
    await search(page).fill('AAPL');
    await expect(page.getByTestId('search-option').first()).toBeVisible();
    await expect(page.getByTestId('search-empty')).toHaveCount(0);
  });

  test('a failing search shows a plain error with a retry (not "no results"), and recovers', async ({
    page,
  }) => {
    await register(page);
    await page.route('**/api/v1/instruments/search**', (r) => r.abort('connectionrefused'));
    await search(page).fill('AAPL');
    await expect(page.getByTestId('search-error')).toContainText('Search is unavailable right now');
    await expect(page.getByTestId('search-error')).toContainText("We can't reach the server");
    await expect(page.getByTestId('search-empty')).toHaveCount(0);
    await page.unroute('**/api/v1/instruments/search**');
    await page.getByTestId('search-error').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('search-option').first()).toBeVisible();
  });

  test('only the newest search answer is shown (a slow old one cannot overwrite it)', async ({
    page,
  }) => {
    await register(page);
    let first = true;
    await page.route('**/api/v1/instruments/search**', async (route) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 1500)); // the first request answers late
      }
      await route.continue();
    });
    await search(page).fill('AAPL');
    await page.waitForTimeout(400); // the first request is in flight
    await search(page).fill('MSFT');
    await expect(page.getByTestId('search-option').first()).toHaveAttribute('data-symbol', 'MSFT');
    await page.waitForTimeout(1800);
    await expect(page.getByTestId('search-option').first()).toHaveAttribute('data-symbol', 'MSFT');
  });

  test('instruments that are not ACTIVE are badged in the results', async ({ page }) => {
    await register(page);
    await control('/instrument', { symbol: 'MSFT', status: 'HALTED' });
    try {
      await search(page).fill('MSFT');
      await expect(
        page.getByTestId('search-option').first().getByTestId('search-status-badge'),
      ).toHaveText('Halted');
    } finally {
      await control('/instrument', { symbol: 'MSFT', status: 'ACTIVE' });
    }
  });
});

test.describe('instrument page', () => {
  test('AAPL: bid, ask, last and the server-computed spread as strings, DELAYED badge, source, as-of and age, market line', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('instrument-name')).toContainText('Apple');
    await expect(page.getByTestId('quote-bid')).toHaveText('189.95');
    await expect(page.getByTestId('quote-ask')).toHaveText('190.00');
    await expect(page.getByTestId('quote-last')).toHaveText('189.97');
    await expect(page.getByTestId('quote-spread')).toHaveText('0.05'); // 190.00 - 189.95, computed by the server
    const panel = page.getByTestId('quote-panel');
    await expect(panel.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'DELAYED');
    await expect(panel).toContainText('Source: FIXTURE');
    await expect(page.getByTestId('quote-as-of')).toContainText('2026-11-10 14:45:00 UTC');
    await expect(page.getByTestId('quote-age')).toHaveText('15 min ago'); // the API's ageSeconds (900), as words
    await expect(page.getByTestId('market-line')).toHaveAttribute('data-market-state', 'OPEN');
    await expect(page.getByTestId('feed-banner')).toHaveText(
      'Simulated market data — not real prices · Demo mode — virtual money, no real trading',
    );
    await page.screenshot({
      path: shotPath('../../docs/phase-reports/m6b/instrument-1280.png'),
      fullPage: true,
    });
  });

  test('your position and your recent orders in this symbol (and none for another symbol)', async ({
    page,
    context,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('position-none')).toHaveText('You do not hold AAPL.');
    await expect(page.getByTestId('recent-orders')).toContainText('No AAPL orders yet');

    await placeOrder(context, BUY_AAPL_10);
    await placeOrder(context, { ...BUY_AAPL_10, qty: '5000' }); // a reject, shown in plain words
    await page.reload();
    await expect(page.getByTestId('position-qty')).toHaveText('10');
    await expect(page.getByTestId('position-avg-cost')).toHaveText('190.04');
    const rows = page.getByTestId('recent-order');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Rejected: You did not have enough cash');
    await expect(rows.nth(1)).toContainText('Filled @ 190.04');

    await page.goto('/instruments/MSFT');
    await expect(page.getByTestId('position-none')).toHaveText('You do not hold MSFT.');
    await expect(page.getByTestId('recent-orders')).toContainText('No MSFT orders yet');
  });

  test('the quote refreshes by itself (D-73): a new price and a stale label appear without a reload', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await page.evaluate(() => {
      (window as unknown as { __noReload: number }).__noReload = 1;
    });
    await setQuote('AAPL', '195.00', '195.05');
    await expect(page.getByTestId('quote-bid')).toHaveText('195.00', { timeout: 15_000 }); // QUOTE_POLL_MS is 1 s
    await expect(page.getByTestId('quote-spread')).toHaveText('0.05');
    await setQuote('AAPL', '195.00', '195.05', { ageSeconds: 2000 });
    await expect(page.getByTestId('quote-panel').getByTestId('freshness-badge')).toHaveAttribute(
      'data-state',
      'STALE',
      {
        timeout: 15_000,
      },
    );
    await clearQuote('AAPL');
    await expect(page.getByTestId('quote-unavailable')).toContainText('no usable price', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('quote-bid')).toContainText('—');
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload),
    ).toBe(1);
  });

  test('a failed refresh keeps the last price, says so with its age, and recovers', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    await page.route('**/api/v1/quotes**', (r) => r.abort('connectionrefused'));
    await expect(page.getByTestId('quote-refresh-failed')).toContainText(
      'Could not refresh the price',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('quote-bid')).toHaveText('189.95'); // the last good price stays on screen
    await page.unroute('**/api/v1/quotes**');
    await expect(page.getByTestId('quote-refresh-failed')).toHaveCount(0, { timeout: 40_000 }); // backoff: 1, 2, 4 s ...
  });

  test('polling pauses while the tab is hidden and resumes at once when it is visible again', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    let polls = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/quotes')) polls += 1;
    });
    await expect.poll(() => polls, { timeout: 10_000 }).toBeGreaterThan(0); // control: it polls while visible
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(700);
    const whileHidden = polls;
    await page.waitForTimeout(4000); // four poll intervals
    expect(polls).toBe(whileHidden);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => polls, { timeout: 1500 }).toBeGreaterThan(whileHidden);
  });

  test('HALTED, SELL_ONLY and DELISTED are explained in words (control: ACTIVE has no notice)', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/MSFT');
    await expect(page.getByTestId('status-explanation')).toHaveCount(0);
    for (const [status, text] of [
      ['HALTED', 'Trading in this instrument is halted'],
      ['SELL_ONLY', 'You can sell shares you already own, but you cannot buy more'],
      ['DELISTED', 'delisted and can no longer be traded'],
    ] as const) {
      await control('/instrument', { symbol: 'MSFT', status });
      try {
        await page.goto('/instruments/MSFT');
        await expect(page.getByTestId('instrument-status')).toHaveAttribute('data-status', status);
        await expect(page.getByTestId('status-explanation')).toContainText(text);
      } finally {
        await control('/instrument', { symbol: 'MSFT', status: 'ACTIVE' });
      }
    }
  });

  test('an unknown symbol or something that is not a ticker shows the not-found page, with the header and search still available', async ({
    page,
  }) => {
    await register(page);
    for (const path of [
      '/instruments/NOSUCH',
      '/instruments/not%20a%20ticker',
      '/instruments/%3Cscript%3E',
    ]) {
      await page.goto(path);
      await expect(page.getByTestId('not-found'), path).toContainText('Not found');
      await expect(search(page)).toBeVisible();
      // the page is marked noindex; the HTTP status stays 200 because the loading state streams first (Next documents this)
      const robots = await page
        .locator('meta[name="robots"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('content')).join(','));
      expect(robots).toContain('noindex');
      await expect(page.getByTestId('instrument-page')).toHaveCount(0);
    }
    await page.goto('/instruments/AAPL'); // control: a real symbol renders the instrument
    await expect(page.getByTestId('instrument-page')).toBeVisible();
    await expect(page.getByTestId('not-found')).toHaveCount(0);
  });

  test('signed-out visitors cannot reach it', async ({ page }) => {
    await page.goto('/instruments/AAPL');
    await expect(page).toHaveURL(/\/login$/);
  });
});
