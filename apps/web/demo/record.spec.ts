// The scripted walkthrough that `pnpm demo:record` films (M10 T6, desktop 1440x900 and phone 390x844). It is not an assertion suite: it
// drives the real app the way the talk track in docs/DEMO_SCRIPT.md describes, and it fails if a step cannot be done, so a recording
// that finishes is a recording of a working demo.
//
// Order: About and the banner -> "Try the demo" -> watchlist -> BTC-USD -> candle interval -> depth book -> a fractional market buy ->
// a resting limit that shows in the book and in Open orders -> cancel (the reserved amount returns) -> portfolio and order history.
//
// Prices are the live simulated ones, so no figure is hard-coded: the limit price is computed from the current quote with integer
// arithmetic (BigInt, no floats).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PACE = Number(process.env.DEMO_PACE_MS ?? '1200');
const pause = (page: Page, factor = 1): Promise<void> => page.waitForTimeout(PACE * factor);

// exact decimal strings <-> integers of 1e-8
const units = (s: string): bigint => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) throw new Error(`not a plain decimal: ${s}`);
  return BigInt(m[1] ?? '0') * 100000000n + BigInt((m[2] ?? '').padEnd(8, '0').slice(0, 8));
};
const price2 = (u: bigint): string =>
  `${(u / 100000000n).toString()}.${((u % 100000000n) / 1000000n).toString().padStart(2, '0')}`;

test('the walkthrough', async ({ page }, info) => {
  const phone = info.project.name === 'demo-phone';

  // 1. the About page and the honesty banner
  await page.goto('/about');
  await expect(page.getByTestId('about-page')).toBeVisible();
  await pause(page, 2);
  await page.mouse.wheel(0, 700);
  await pause(page, 2);

  // 2. the demo button
  await page.goto('/login');
  await expect(page.getByTestId('feed-banner')).toBeVisible();
  await pause(page);
  await page.getByTestId('demo-button').click();
  await page.waitForURL('**/portfolio');
  await expect(page.getByTestId('demo-notice')).toBeVisible();
  await expect(page.getByTestId('metric-equity')).toContainText('10,000.00');
  await pause(page, 2);

  // 3. the watchlist, then BTC-USD
  await page.goto('/instruments/AAPL');
  await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 30_000 });
  if (phone) {
    await page.getByTestId('watchlist-open').tap();
    await expect(page.getByTestId('watchlist-drawer')).toBeVisible();
  }
  await expect(page.getByTestId('watch-row').first()).toBeVisible();
  await pause(page, 2);
  if (phone) await page.getByTestId('watchlist-drawer').getByTestId('watch-link').first().tap();
  await page.goto('/instruments/BTC-USD');
  await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 30_000 });
  await pause(page, 2);

  // 4. another candle interval
  const tablist = page.getByRole('tablist', { name: 'Candle interval' });
  await tablist.getByRole('tab', { name: '5m', exact: true }).click();
  await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 30_000 });
  await pause(page, 2);

  // 5. the depth book and its honesty label
  if (phone) await page.getByRole('tab', { name: 'Book' }).tap();
  await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('depth-honesty')).toBeVisible();
  await pause(page, 3);

  // 6. a fractional market buy
  if (phone) await page.getByTestId('action-buy').tap();
  await page.getByTestId('ticket-qty').fill('0.0025');
  await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 20_000 });
  await pause(page);
  await page.getByTestId('review-button').click();
  await pause(page);
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-filled')).toBeVisible();
  await pause(page, 3);
  await page.getByTestId('result-close').click();

  // 7. a resting limit BUY about 3 % below the bid (it rests: the book shows "Your order", Open orders lists it)
  const q = (await (await page.request.get('/api/v1/quotes?symbols=BTC-USD')).json()) as {
    quotes: Array<{ bid: string }>;
  };
  const bid = q.quotes[0]?.bid;
  if (bid === undefined) throw new Error('no BTC-USD quote');
  const limit = price2(((units(bid) * 97n) / 100n / 1000000n) * 1000000n);
  if (phone) await page.getByTestId('action-buy').tap();
  await page.locator('label:has([data-testid="kind-limit"])').click();
  await page.getByTestId('ticket-qty').fill('0.0025');
  await page.getByTestId('ticket-limit').fill(limit);
  await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 20_000 });
  await pause(page);
  await page.getByTestId('review-button').click();
  await pause(page);
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-accepted')).toBeVisible();
  await pause(page, 2);
  await page.getByTestId('result-close').click();
  if (phone) await page.getByRole('tab', { name: /Orders/ }).tap();
  else await page.getByTestId('bottom-tab-open').click();
  await expect(page.getByTestId('open-order-row').first()).toBeVisible({ timeout: 30_000 });
  await pause(page, 3);

  // 8. cancel: the reserved amount returns
  await page.getByTestId('cancel-button').first().click();
  await expect(page.getByTestId('cancel-notice')).toBeVisible({ timeout: 30_000 });
  await pause(page, 3);

  // 9. portfolio and order history
  await page.goto('/portfolio');
  await expect(page.getByTestId('metric-equity')).toBeVisible();
  await pause(page, 3);
  await page.goto('/orders');
  await expect(page.getByTestId('order-row').first()).toBeVisible();
  await pause(page, 3);
});
