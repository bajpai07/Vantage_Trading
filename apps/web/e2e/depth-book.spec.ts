// M8b-2 end to end: the simulated order book on the instrument page, through the real web app, API, matcher and Postgres.
// The quote is scripted through the control server (BTC-USD bid 89,990.00 / ask 90,010.00): the ladder is the hand-verified vector
// J of packages/engine/src/depth.test.ts (levelStep 9.64, level 3 bid 89,970.72, level 15 ask 90,144.96). The book is informational:
// these tests also check that it is labelled as such everywhere it is shown.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { control, enterQty, register, setQuote } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const HONESTY =
  'Simulated depth: informational. Fills use the simulated execution model (QBX-1), not this book.';

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('BTC-USD', '89990.00', '90010.00');
});

async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

async function restLimitBuy(page: Page, qty: string, price: string): Promise<void> {
  await page.locator('label:has([data-testid="kind-limit"])').click();
  await enterQty(page, qty);
  await page.getByTestId('ticket-limit').fill(price);
  await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('review-button').click();
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-accepted')).toBeVisible();
  await page.getByTestId('result-close').click();
}

test.describe('the book renders, is labelled, and matches the quote', () => {
  test('honesty label as visible text, best bid and ask equal the header quote, the ladder is vector J, spread and mid are the server strings', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('depth-honesty')).toHaveText(HONESTY); // visible text, not a tooltip
    await expect(page.getByTestId('feed-banner')).toContainText('Simulated market data'); // the banner stays
    await expect(page.getByTestId('depth-table').locator('caption')).toContainText(
      'Simulated order book for BTC-USD',
    );

    // best bid / best ask are the quote shown in the header
    const asks = page.getByTestId('depth-ask-row');
    const bids = page.getByTestId('depth-bid-row');
    await expect(asks).toHaveCount(15);
    await expect(bids).toHaveCount(15);
    // asks are listed with the LOWEST nearest the spread (the last ask row is level 1)
    await expect(asks.last().getByTestId('depth-price')).toHaveText(
      await page.getByTestId('quote-ask').innerText(),
    );
    await expect(bids.first().getByTestId('depth-price')).toHaveText(
      await page.getByTestId('quote-bid').innerText(),
    );
    await expect(asks.last().getByTestId('depth-price')).toHaveText('90,010.00');
    await expect(bids.first().getByTestId('depth-price')).toHaveText('89,990.00');
    // vector J: levels 3 and 15 on both sides
    await expect(asks.nth(12).getByTestId('depth-price')).toHaveText('90,029.28'); // ask level 3
    await expect(asks.first().getByTestId('depth-price')).toHaveText('90,144.96'); // ask level 15
    await expect(bids.nth(2).getByTestId('depth-price')).toHaveText('89,970.72'); // bid level 3
    await expect(bids.last().getByTestId('depth-price')).toHaveText('89,855.04'); // bid level 15
    await expect(page.getByTestId('depth-spread')).toHaveText('20.00');
    await expect(page.getByTestId('depth-mid')).toHaveText('90,000.00');
    // the bars are decoration only
    await expect(page.getByTestId('depth-bar').first()).toHaveAttribute('aria-hidden', 'true');
  });
});

test.describe('your resting order is marked on the book and disappears when cancelled', () => {
  test('a limit BUY at bid level 3 shows "Your order" at that row; one off the ladder is in the outside note; cancelling removes both', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('depth-your-order')).toHaveCount(0);

    await restLimitBuy(page, '0.0025', '89970.72'); // exactly bid level 3
    const level3 = page.getByTestId('depth-bid-row').nth(2);
    await expect(level3).toHaveAttribute('data-level', '3');
    await expect(level3.getByTestId('depth-your-order')).toContainText('Your order', {
      timeout: 15_000,
    });
    await expect(level3.getByTestId('depth-price')).toHaveText('89,970.72');
    await expect(page.getByTestId('depth-your-order')).toHaveCount(1); // text, not colour only

    await restLimitBuy(page, '0.0025', '89000.00'); // far below the 15 levels
    await expect(page.getByTestId('depth-outside')).toContainText(
      'Your orders outside the visible book',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('depth-outside-order')).toContainText('89,000.00');

    // cancel both on the orders page; the book is clean when we come back
    await page.goto('/orders');
    await expect(page.getByTestId('open-order-row')).toHaveCount(2);
    await page.getByTestId('cancel-button').first().click();
    await expect(page.getByTestId('open-order-row')).toHaveCount(1);
    await page.getByTestId('cancel-button').first().click();
    await expect(page.getByTestId('open-orders-empty')).toBeVisible();
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('depth-your-order')).toHaveCount(0);
    await expect(page.getByTestId('depth-outside')).toHaveCount(0);
  });
});

test.describe('clicking a price copies the price string into the limit price', () => {
  test('in Limit mode the price is copied exactly; in Market mode the row says why it cannot', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    const level3 = page.getByTestId('depth-bid-row').nth(2).getByTestId('depth-price');

    // Market mode (the default): disabled with a reason, nothing is copied
    await expect(level3).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('depth-pick-hint')).toHaveText(
      'Switch the order ticket to Limit to copy a price from the book.',
    );
    await level3.click({ force: true }); // aria-disabled: Playwright waits for "enabled", a person can still click
    await expect(page.getByTestId('ticket-limit')).toHaveCount(0);

    // Limit mode: the row's own string, no arithmetic
    await page.locator('label:has([data-testid="kind-limit"])').click();
    await expect(page.getByTestId('ticket-limit')).toHaveValue('');
    await expect(level3).not.toHaveAttribute('aria-disabled', 'true');
    await level3.click();
    await expect(page.getByTestId('ticket-limit')).toHaveValue('89970.72');
    await page.getByTestId('depth-ask-row').last().getByTestId('depth-price').click();
    await expect(page.getByTestId('ticket-limit')).toHaveValue('90010.00');
  });
});

test.describe('freshness: a stale quote replaces the book with a message and no levels', () => {
  test('stale quote: "Depth unavailable: quote is stale." and no rows; a fresh quote brings the book back', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    await setQuote('BTC-USD', '89990.00', '90010.00', { ageSeconds: 3600 });
    await expect(page.getByTestId('depth-unavailable')).toHaveText(
      'Depth unavailable: quote is stale.',
      { timeout: 20_000 },
    );
    await expect(page.getByTestId('depth-ask-row')).toHaveCount(0);
    await expect(page.getByTestId('depth-bid-row')).toHaveCount(0);
    await expect(page.getByTestId('depth-honesty')).toHaveText(HONESTY); // the label stays
    expect(await serious(page)).toEqual([]); // axe: stale state

    await setQuote('BTC-USD', '89990.00', '90010.00');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('depth-ask-row')).toHaveCount(15);
  });
});

test.describe('accessibility, keyboard and phone width', () => {
  test('axe is clean (loaded); the table has a caption and column headers; a price is reachable and works from the keyboard; no horizontal scroll at 375 px', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    expect(await serious(page)).toEqual([]);
    await expect(page.getByRole('table', { name: /Simulated order book/ })).toBeVisible();
    await expect(page.getByTestId('depth-table').getByRole('columnheader')).toHaveText([
      'Price (USD)',
      'Size',
      'Yours',
    ]);

    // keyboard only: focus a price button with Tab, activate with Enter (Limit mode), the string lands in the field
    await page.locator('label:has([data-testid="kind-limit"])').click();
    const target = page.getByTestId('depth-bid-row').nth(2).getByTestId('depth-price');
    await target.focus();
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ticket-limit')).toHaveValue('89970.72');

    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByTestId('depth-ready')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('loading and error states are accessible and carry the label (the depth route fails)', async ({
    page,
  }) => {
    await register(page);
    await page.route('**/api/v1/market/depth?**', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 500, body: '{}' });
    });
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-loading')).toBeVisible();
    await expect(page.getByTestId('depth-honesty')).toHaveText(HONESTY);
    expect(await serious(page)).toEqual([]); // axe: loading
    await expect(page.getByTestId('depth-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('depth-ask-row')).toHaveCount(0);
    expect(await serious(page)).toEqual([]); // axe: error
  });
});

test.describe('polling hygiene', () => {
  test('requests never overlap and stop while the tab is hidden', async ({ page }) => {
    await register(page);
    let inFlight = 0;
    let maxInFlight = 0;
    let count = 0;
    await page.route('**/api/v1/market/depth?**', async (route) => {
      inFlight += 1;
      count += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 400));
      inFlight -= 1;
      await route.continue();
    });
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => count, { timeout: 20_000 }).toBeGreaterThanOrEqual(2); // it keeps polling
    expect(maxInFlight).toBe(1);

    // hidden tab: no new requests (the quote feed rule)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(700); // let a request already started finish
    const before = count;
    await page.waitForTimeout(7000); // more than one poll interval (5 s)
    expect(count).toBe(before);
  });
});
