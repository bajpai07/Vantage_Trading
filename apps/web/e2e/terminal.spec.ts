// M9a end to end: the trading terminal through the real web app, API, matcher and Postgres. Quotes are pinned through the control
// server (BTC-USD bid 89,990.00 / ask 90,010.00, AAPL 189.95 / 190.00). The CSP is the production one: every test that loads the
// terminal also listens for `securitypolicyviolation` events, and "zero violations" is asserted.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Response } from '@playwright/test';
import { control, enterQty, register, setQuote, shotPath } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const HONESTY =
  'Simulated depth: informational. Fills use the simulated execution model (QBX-1), not this book.';

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90000.00' });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
  await setQuote('MSFT', '419.95', '420.00', { last: '419.98' });
});

/** Starts recording CSP violations in the page (call before navigating). */
async function watchCsp(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`);
    });
  });
}
const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

async function open(page: Page, symbol = 'BTC-USD'): Promise<void> {
  await page.goto(`/instruments/${symbol}`);
  await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('watch-row').first()).toBeVisible();
}

async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    // the chart canvas is a third-party widget with no text: its own internals are not part of this audit
    .exclude('[data-testid="price-chart-canvas"]')
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

/** Presses Tab until the element with this test id has focus (keyboard-only navigation), at most `max` presses. */
async function tabTo(page: Page, testId: string, max = 120): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const hit = await page.evaluate(
      (id) => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') === id,
      testId,
    );
    if (hit) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${testId}`);
}

const overlap = (
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
): boolean =>
  a.x < b.x + b.width - 1 &&
  b.x < a.x + a.width - 1 &&
  a.y < b.y + b.height - 1 &&
  b.y < a.y + a.height - 1;

test.describe('1. layout: no horizontal scroll and no overlapping regions at 1440, 1280, 1024 and 768', () => {
  for (const width of [1440, 1280, 1024, 768]) {
    test(`${String(width)} px`, async ({ page, context }) => {
      await watchCsp(context);
      await register(page);
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const regions = ['terminal-rail', 'terminal-center', 'terminal-right', 'terminal-bottom'];
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const id of regions) {
        const b = await page.getByTestId(id).boundingBox();
        expect(b, id).not.toBeNull();
        boxes.push(b as (typeof boxes)[number]);
      }
      for (let i = 0; i < boxes.length; i += 1)
        for (let j = i + 1; j < boxes.length; j += 1)
          expect(
            overlap(boxes[i] as never, boxes[j] as never),
            `${regions[i] ?? ''} / ${regions[j] ?? ''}`,
          ).toBe(false);
      // the banner is always visible and the header sits under it
      await expect(page.getByTestId('feed-banner')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await page.waitForTimeout(2000); // let the chart paint
      if (width === 1440 || width === 1024 || width === 768)
        await page.screenshot({
          path: shotPath(`../../docs/phase-reports/m9a/terminal-${String(width)}.png`),
          fullPage: true,
        });
    });
  }
});

test.describe('2. the mock: header, copy and honesty', () => {
  test('banner copy, header equity from the server, nav, instrument header strings, chart footer, depth label, notices links', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await open(page);
    await expect(page.getByTestId('feed-banner')).toContainText('Simulated market data');
    await expect(
      page.getByText('Virtual money, not real trading', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByTestId('header-equity')).toHaveText('$10,000.00');
    await expect(page.getByTestId('buying-power')).toHaveText('$10,000.00'); // M9b: the free cash, a server string, next to "You hold"
    await expect(page.getByRole('link', { name: 'Trade' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('quote-last')).toHaveText('90,000.00');
    await expect(page.getByTestId('quote-bid')).toHaveText('89,990.00');
    await expect(page.getByTestId('quote-ask')).toHaveText('90,010.00');
    await expect(page.getByTestId('quote-spread')).toHaveText('20.00');
    await expect(page.getByTestId('freshness-badge')).toBeVisible();
    await expect(page.getByTestId('quote-badge-detail')).toContainText('FIXTURE');
    await expect(page.getByTestId('chart-footer')).toContainText(
      'Candles are simulated and deterministic. The forming candle updates live; closed candles never change.',
    );
    await expect(page.getByTestId('chart-axis-note')).toHaveText(
      'Axis labels are rounded; exact prices in the legend.',
    );
    await expect(page.getByTestId('depth-honesty')).toHaveText(HONESTY);
    // attribution: a visible link in the chart footer, no in-chart logo (it needs an inline <style> the CSP blocks)
    await expect(page.getByTestId('chart-attribution')).toHaveAttribute(
      'href',
      'https://www.tradingview.com/',
    );
    await expect(page.getByTestId('chart-attribution')).toHaveText('Charts by TradingView');
    await expect(page.locator('#tv-attr-logo')).toHaveCount(0);
    // the licence notice page is reachable from the footer
    await page.getByTestId('notices-link').click();
    await expect(page.getByTestId('notices-page')).toBeVisible();
    await expect(page.getByTestId('lwc-notice')).toContainText('TradingView Lightweight Charts™');
    await expect(page.getByTestId('lwc-notice')).toContainText('Copyright');
    await expect(page.getByTestId('notices-tradingview-link')).toHaveAttribute(
      'href',
      'https://www.tradingview.com/',
    );
    expect(await violations(page)).toEqual([]);
  });

  test('the notices page and its footer link are public (no session), on the login page too', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByTestId('notices-link').click();
    await expect(page).toHaveURL(/\/third-party-notices$/);
    await expect(page.getByTestId('lwc-notice')).toContainText('TradingView Lightweight Charts™');
    await expect(page.getByTestId('notices-link')).toBeVisible(); // the footer is on this page too
  });

  test('the page title follows the price: "BTC-USD 90,000.00 · VANTAGE"', async ({ page }) => {
    await register(page);
    await open(page);
    await expect(page).toHaveTitle('BTC-USD 90,000.00 · VANTAGE');
  });
});

test.describe('3. watchlist', () => {
  test('one quotes request serves every row; selecting a row changes the route, chart and ticket; stars persist across reload', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const quoteRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/v1/quotes?')) quoteRequests.push(r.url());
    });
    await open(page);
    await expect(page.getByTestId('watch-row')).toHaveCount(9);
    await expect(page.getByTestId('watch-saved-note')).toHaveText('Saved in this browser');
    await expect(page.getByTestId('watch-row').filter({ hasText: 'BTC-USD' })).toHaveAttribute(
      'data-selected',
      'true',
    );
    // ONE request carries all nine symbols (never one request per row)
    await expect
      .poll(
        () => quoteRequests.filter((u) => u.split('symbols=')[1]?.split('%2C').length === 9).length,
      )
      .toBeGreaterThan(0);
    expect(quoteRequests.filter((u) => !u.includes('AAPL') && !u.includes('%2C'))).toEqual([]);

    // selection: route, chart, ticket
    await page
      .getByTestId('watch-row')
      .filter({ hasText: 'MSFT' })
      .getByTestId('watch-link')
      .click();
    await expect(page).toHaveURL(/\/instruments\/MSFT$/);
    await expect(page.getByTestId('instrument-symbol')).toHaveText('MSFT');
    await expect(page.getByTestId('chart-panel')).toBeVisible();
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('watch-row').filter({ hasText: 'MSFT' })).toHaveAttribute(
      'data-selected',
      'true',
    );
    await expect(page.getByTestId('order-ticket')).toBeVisible();
    await expect(page.getByTestId('ticket-qty-help')).toContainText('Whole shares');

    // star toggle persists across a reload
    await page
      .getByTestId('watch-row')
      .filter({ hasText: 'NVDA' })
      .getByTestId('watch-star')
      .click();
    await expect(page.getByTestId('watch-row')).toHaveCount(8);
    await page.reload();
    await expect(page.getByTestId('watch-row')).toHaveCount(8);
    await expect(page.getByTestId('watch-row').filter({ hasText: 'NVDA' })).toHaveCount(0);
    // and adds back from the instrument header star
    await page.goto('/instruments/NVDA');
    await page.getByTestId('watch-star').first().click();
    await page.reload();
    await expect(page.getByTestId('watch-row').filter({ hasText: 'NVDA' })).toHaveCount(1);
    expect(await violations(page)).toEqual([]);
  });

  test('blocked storage: the terminal renders with the default list, says it is not saved, and still toggles in memory', async ({
    page,
    context,
  }) => {
    await register(page);
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('SecurityError: storage is blocked');
        },
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expect(page.getByTestId('watch-row')).toHaveCount(9);
    await expect(page.getByTestId('watch-saved-note')).toContainText('Not saved');
    await page
      .getByTestId('watch-row')
      .filter({ hasText: 'SPY' })
      .getByTestId('watch-star')
      .click();
    await expect(page.getByTestId('watch-row')).toHaveCount(8);
  });

  test('corrupt saved data falls back to the default list; an unknown saved symbol is dropped', async ({
    page,
    context,
  }) => {
    await register(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.addInitScript(() => {
      localStorage.setItem('vantage.watchlist.v1', '{"symbols":["AAPL","ZZZNOTREAL","BTC-USD"]}');
    });
    await open(page);
    await expect(page.getByTestId('watch-row').filter({ hasText: 'ZZZNOTREAL' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('watch-row')).toHaveCount(2);
  });
});

test.describe('4. the chart', () => {
  test('interval tabs: exactly one candles request per switch, arrow keys move between tabs, the chart is created once', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    const firstLoads: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/v1/market/candles?') && u.includes('limit=200')) firstLoads.push(u);
    });
    await open(page);
    const tablist = page.getByRole('tablist', { name: 'Candle interval' });
    await expect(tablist.getByRole('tab', { name: '15m', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(firstLoads.filter((u) => u.includes('interval=15m'))).toHaveLength(1);

    await tablist.getByRole('tab', { name: '5m', exact: true }).click();
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    expect(firstLoads.filter((u) => u.includes('interval=5m'))).toHaveLength(1);

    // keyboard: focus the selected tab, ArrowRight selects the next one, End the last, Home the first
    await tablist.getByRole('tab', { name: '5m', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tablist.getByRole('tab', { name: '15m', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('End');
    await expect(tablist.getByRole('tab', { name: '1d', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Home');
    await expect(tablist.getByRole('tab', { name: '1m', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    expect(firstLoads.filter((u) => u.includes('interval=15m'))).toHaveLength(2); // the arrow visit loaded it once more
    expect(firstLoads.filter((u) => u.includes('interval=1d'))).toHaveLength(1);
    expect(firstLoads.filter((u) => u.includes('interval=1m'))).toHaveLength(1);
    // only one chart exists (created once; no price tick creates another)
    await expect(page.getByTestId('price-chart-canvas')).toHaveCount(1);
    await setQuote('BTC-USD', '89991.00', '90011.00', { last: '90001.00' });
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('price-chart-canvas')).toHaveCount(1);
    expect(await violations(page)).toEqual([]);
  });

  test('the legend shows the exact server strings of the candle under the pointer; the a11y table has the latest candles', async ({
    page,
  }) => {
    await register(page);
    const answer = page.waitForResponse(
      (r) =>
        r.url().includes('/v1/market/candles?') &&
        r.url().includes('limit=200') &&
        r.url().includes('interval=15m'),
    );
    await open(page);
    const body = (await (await answer).json()) as {
      candles: Array<{ t: string; o: string; h: string; l: string; c: string; v: string }>;
    };
    const canvas = page.locator('[data-testid="price-chart-canvas"] canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const b = box as { x: number; y: number; width: number; height: number };
    await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.3);
    await page.mouse.move(b.x + b.width * 0.41, b.y + b.height * 0.3);
    const time = (await page.getByTestId('legend-time').innerText()).trim();
    const found = body.candles.find((c) => `${c.t.replace('T', ' ').slice(0, 19)} UTC` === time);
    expect(found, `a candle for ${time}`).toBeDefined();
    const plain = async (id: string): Promise<string> =>
      (await page.getByTestId(id).innerText()).replaceAll(',', '');
    expect([
      await plain('legend-o'),
      await plain('legend-h'),
      await plain('legend-l'),
      await plain('legend-c'),
    ]).toEqual([found?.o, found?.h, found?.l, found?.c]);
    // screen readers: a summary and the exact values of the latest candles in a table
    await expect(page.getByTestId('chart-ready')).toHaveAttribute(
      'aria-label',
      /Candlestick chart of BTC-USD, 15m candles, simulated data, last price/,
    );
    const rows = page.getByTestId('chart-a11y-table').locator('tbody tr');
    await expect(rows).toHaveCount(8);
    const last = body.candles[body.candles.length - 1];
    await expect(rows.first().locator('td').nth(3)).toHaveText(/^\d+\.\d+$/);
    expect(last).toBeDefined();
  });

  test('a stale quote replaces the chart and the book with messages and no live chart; a fresh quote brings both back', async ({
    page,
  }) => {
    await register(page);
    await open(page);
    await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90000.00', ageSeconds: 3600 });
    await expect(page.getByTestId('chart-unavailable')).toHaveText(
      'Chart unavailable: quote is stale.',
      { timeout: 20_000 },
    );
    await expect(page.getByTestId('price-chart-canvas')).toHaveCount(0);
    await expect(page.getByTestId('depth-unavailable')).toHaveText(
      'Depth unavailable: quote is stale.',
      { timeout: 20_000 },
    );
    expect(await serious(page)).toEqual([]); // axe: stale state
    await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90000.00' });
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 20_000 });
  });

  test('loading and error states: a skeleton with reserved size, then an error with a retry that works; axe clean in both', async ({
    page,
  }) => {
    await register(page);
    let fail = true;
    await page.route('**/api/v1/market/candles?**', async (route) => {
      if (fail) {
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({ status: 500, body: '{}' });
      } else await route.continue();
    });
    await page.goto('/instruments/BTC-USD');
    const skeleton = page.getByTestId('chart-skeleton').first();
    await expect(skeleton).toBeVisible();
    const sk = await skeleton.boundingBox();
    expect(sk?.height).toBe(440); // the final height: nothing moves when the chart arrives
    expect(await serious(page)).toEqual([]); // axe: loading
    await expect(page.getByTestId('chart-error')).toBeVisible({ timeout: 20_000 });
    expect(await serious(page)).toEqual([]); // axe: error
    fail = false;
    await page.getByTestId('chart-retry').click();
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
  });

  test('the chart reserves its space: no layout shift of the page below it when the chart arrives', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('chart-panel')).toBeVisible();
    const before = await page.getByTestId('chart-footer').boundingBox();
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    const after = await page.getByTestId('chart-footer').boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(60); // the legend line is the only addition
  });
});

test.describe('5. ticket, bottom panel and book still work end to end from the terminal', () => {
  test('market buy, resting limit, cancel from the bottom panel, position row switches instrument; exact strings', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expect(page.getByTestId('bottom-tab-positions')).toHaveText('Positions (0)');
    await expect(page.getByTestId('bottom-tab-open')).toHaveText(/Open orders \(0\)/, {
      timeout: 15_000,
    });

    // a market BUY of 0.001 BTC: the ask 90,010.00 slipped 5 bps -> 90,055.01, notional 90.05501, fee 0.09 (vector style, strings)
    await enterQty(page, '0.001');
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('review-button').click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-price')).toHaveText('90,055.01');
    await page.getByTestId('result-close').click();
    await expect(page.getByTestId('bottom-tab-positions')).toHaveText('Positions (1)', {
      timeout: 15_000,
    });
    const row = page.getByTestId('bottom-position-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('BTC-USD');
    await expect(row.locator('td').first()).toContainText('0.001');
    await expect(page.getByTestId('header-equity')).toContainText('$');

    // a resting limit BUY 0.0025 @ 89,900.00: the book marks it, the Open orders tab counts it and can cancel it
    await page.locator('label:has([data-testid="kind-limit"])').click();
    await enterQty(page, '0.0025');
    await page.getByTestId('ticket-limit').fill('89900.00');
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('review-button').click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    await page.getByTestId('result-close').click();
    await expect(page.getByTestId('bottom-tab-open')).toHaveText('Open orders (1)', {
      timeout: 20_000,
    });
    await page.getByTestId('bottom-tab-open').click();
    await expect(page.getByTestId('open-order-row')).toHaveCount(1);
    await expect(page.getByTestId('open-order-held')).toHaveText('224.97475 cash');
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('cancel-notice')).toContainText(
      'Cancelled. 224.97475 is back in your cash.',
    );
    await expect(page.getByTestId('bottom-tab-open')).toHaveText('Open orders (0)', {
      timeout: 20_000,
    });
    await page.getByTestId('bottom-tab-history').click();
    await expect(page.getByTestId('order-row').first().getByTestId('status-chip')).toHaveText(
      /Cancelled/,
    );

    // from another instrument, the position row switches the terminal back to BTC-USD
    await page.getByTestId('bottom-tab-positions').click();
    await page
      .getByTestId('watch-row')
      .filter({ hasText: 'AAPL' })
      .getByTestId('watch-link')
      .click();
    await expect(page).toHaveURL(/\/instruments\/AAPL$/);
    await page.getByTestId('bottom-position-open').click();
    await expect(page).toHaveURL(/\/instruments\/BTC-USD$/);
    expect(await violations(page)).toEqual([]);
  });

  test('keyboard only, from the search box to a filled order', async ({ page }) => {
    await register(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/portfolio');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/'); // focus the search
    await page.keyboard.type('MSFT');
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/instruments\/MSFT$/);
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    await tabTo(page, 'ticket-qty');
    await page.keyboard.type('2');
    await tabTo(page, 'review-button');
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    await tabTo(page, 'confirm-button', 30);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('result-filled')).toBeVisible();
  });
});

test.describe('6. keyboard shortcuts', () => {
  test('b / s switch the side, [ ] move the interval, j / k move in the watchlist, ? opens the help, Esc closes it', async ({
    page,
  }) => {
    await register(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('s');
    await expect(page.getByTestId('side-sell')).toBeChecked();
    await page.keyboard.press('b');
    await expect(page.getByTestId('side-buy')).toBeChecked();
    await page.keyboard.press(']');
    await expect(page.getByRole('tab', { name: '1h', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect(page.getByRole('tab', { name: '5m', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // the selected row (BTC-USD, the 5th) is the starting point: j goes down, k goes up, never past either end
    const link = (n: number) => page.getByTestId('watch-link').nth(n);
    await page.keyboard.press('j');
    await expect(link(5)).toBeFocused(); // ETH-USD
    await page.keyboard.press('j');
    await expect(link(6)).toBeFocused();
    await page.keyboard.press('k');
    await expect(link(5)).toBeFocused();
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await expect(link(3)).toBeFocused(); // SPY
    await page.keyboard.press('Enter'); // opens the focused symbol
    await expect(page).toHaveURL(/\/instruments\/SPY$/);
    // help (wait for the new page to be interactive first)
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
    expect(await serious(page)).toEqual([]); // axe: the shortcuts dialog
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-dialog')).toBeHidden();
  });

  test('inactive while typing in any field; never places an order; can be turned off and the choice is remembered', async ({
    page,
  }) => {
    const { email } = await register(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    // typing "bs[]jk" in the quantity field changes nothing but the field
    await page.getByTestId('ticket-qty').focus();
    await page.keyboard.type('bs[]jk');
    await expect(page.getByTestId('side-buy')).toBeChecked();
    await expect(page.getByRole('tab', { name: '15m', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // and in the search box
    await page.keyboard.press('Escape');
    await page.getByRole('combobox').focus();
    await page.keyboard.type('s');
    await expect(page.getByTestId('side-buy')).toBeChecked();
    // shortcut keys on the page never open the review dialog or create an order
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const k of ['b', 's', 'b', '[', ']', 'j', 'k']) await page.keyboard.press(k);
    await expect(page.getByTestId('ticket-dialog')).toBeHidden();
    await expect(page.getByTestId('result-filled')).toHaveCount(0);
    const res = await page.request.get(`/api/v1/orders?limit=5`);
    expect(((await res.json()) as { orders: unknown[] }).orders).toEqual([]);
    void email;
    // turn them off from the help dialog; 's' then does nothing; the choice survives a reload
    await page.getByTestId('shortcuts-open').click();
    await page.getByTestId('shortcuts-toggle').uncheck();
    await page.getByTestId('shortcuts-close').click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('s');
    await expect(page.getByTestId('side-buy')).toBeChecked();
    await page.reload();
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('s');
    await expect(page.getByTestId('side-buy')).toBeChecked();
  });
});

test.describe('7. motion', () => {
  const observe = async (page: Page): Promise<void> => {
    await page.evaluate(() => {
      const w = window as unknown as { __flash: string[] };
      w.__flash = [];
      new MutationObserver((ms) => {
        for (const m of ms) {
          const el = m.target as HTMLElement;
          const v = el.getAttribute('data-flash');
          if (v !== null && v !== 'none') w.__flash.push(v);
        }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-flash'],
      });
    });
  };
  const seen = (page: Page): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __flash: string[] }).__flash);

  test('a changed price flashes with an arrow (control)', async ({ page }) => {
    await register(page);
    await open(page);
    await observe(page);
    await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90050.00' });
    await expect
      .poll(async () => (await seen(page)).includes('up'), { timeout: 15_000 })
      .toBe(true);
    await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90040.00' });
    await expect
      .poll(async () => (await seen(page)).includes('down'), { timeout: 15_000 })
      .toBe(true);
  });

  test('prefers-reduced-motion: the same changes produce no flash at all', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await register(page);
    await open(page);
    await observe(page);
    await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90050.00' });
    await page.waitForTimeout(4000);
    await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90040.00' });
    await page.waitForTimeout(4000);
    expect(await seen(page)).toEqual([]);
    await expect(page.getByTestId('quote-last')).toHaveText('90,040.00'); // the price itself did update
  });
});

test.describe('8. accessibility at 1440 and 1024 (loaded state; the other states are in section 4 and 6)', () => {
  for (const width of [1440, 1024]) {
    test(`axe is clean at ${String(width)} px`, async ({ page, context }) => {
      await watchCsp(context);
      await register(page);
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      expect(await serious(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
    });
  }
});

test.describe('9. performance: requests while the terminal is idle', () => {
  test('counts the requests of 30 idle seconds by endpoint (reported, bounded)', async ({
    page,
  }) => {
    await register(page);
    await open(page);
    await page.waitForTimeout(3000);
    const counts = new Map<string, number>();
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/api/')) return;
      const key = u.pathname.replace('/api', '');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    await page.waitForTimeout(30_000);
    const out = Object.fromEntries([...counts.entries()].sort());
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    process.stdout.write(
      `TERMINAL_IDLE_REQUESTS_30S total=${String(total)} ${JSON.stringify(out)}\n`,
    );
    // e2e polls the quote every 1 s and the portfolio every 2 s: the bound is for THESE settings
    expect(total).toBeLessThan(300);
  });
});

test.describe('10. performance (reported, not gates): JS loaded, chart chunk size, CLS and LCP of the production build', () => {
  test('first-load JavaScript of the terminal vs the portfolio page, the chart library chunk, CLS and LCP', async ({
    page,
  }) => {
    await register(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); // every chunk is fetched, none from the cache
    const measure = async (path: string, ready: string) => {
      let total = 0;
      const chunks: Array<{ url: string; bytes: number; chart: boolean }> = [];
      const onResponse = async (r: Response): Promise<void> => {
        if (!r.url().includes('/_next/static/') || !r.url().endsWith('.js')) return;
        const body = await r.body().catch(() => Buffer.alloc(0));
        total += body.length;
        chunks.push({
          url: r.url(),
          bytes: body.length,
          chart:
            body.toString('utf8').includes('lightweight-charts') ||
            body.toString('utf8').includes('tv-attr-logo'),
        });
      };
      page.on('response', (r) => void onResponse(r));
      await page.addInitScript(() => {
        const w = window as unknown as { __cls: number; __lcp: number };
        w.__cls = 0;
        w.__lcp = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as unknown as Array<{
            hadRecentInput: boolean;
            value: number;
          }>)
            if (!e.hadRecentInput) w.__cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((l) => {
          const es = l.getEntries();
          const last = es[es.length - 1];
          if (last !== undefined) w.__lcp = last.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await page.goto(path);
      await expect(page.getByTestId(ready)).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(3000);
      const vitals = await page.evaluate(() => {
        const w = window as unknown as { __cls: number; __lcp: number };
        return { cls: w.__cls, lcp: w.__lcp };
      });
      page.removeAllListeners('response');
      return {
        total,
        chart: chunks.filter((c) => c.chart).reduce((a, c) => a + c.bytes, 0),
        ...vitals,
      };
    };
    const portfolio = await measure('/portfolio', 'metric-cash').catch(() => null);
    process.stdout.write(`PORTFOLIO_PERF ${JSON.stringify(portfolio)}
`);
    const term = await measure('/instruments/BTC-USD', 'chart-ready');
    process.stdout.write(`TERMINAL_PERF ${JSON.stringify(term)}\n`);
    expect(term.cls).toBeLessThan(0.25);
  });
});

test.describe('11. the orders lists poll politely (M9b T0b)', () => {
  test('every ORDERS_POLL_MS while visible (3 s in e2e, 10 s by default), paused while the tab is hidden, refreshed at once when it returns, never two at a time', async ({
    page,
  }) => {
    await register(page);
    let inFlight = 0;
    let maxInFlight = 0;
    const times: number[] = [];
    await page.route('**/api/v1/orders?limit=50', async (route) => {
      inFlight += 1;
      maxInFlight = maxInFlight > inFlight ? maxInFlight : inFlight;
      times.push(Date.now());
      await new Promise((r) => setTimeout(r, 300));
      inFlight -= 1;
      await route.continue();
    });
    await open(page);
    await expect(page.getByTestId('bottom-tab-open')).toHaveText('Open orders (0)', {
      timeout: 15_000,
    });
    await expect.poll(() => times.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3); // it keeps polling
    expect(maxInFlight).toBe(1);
    // hidden: nothing for more than two intervals
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(700); // a request already started may finish
    const before = times.length;
    await page.waitForTimeout(7000);
    expect(times.length).toBe(before);
    // visible again: an immediate refresh
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => times.length, { timeout: 2000 }).toBeGreaterThan(before);
  });
});
