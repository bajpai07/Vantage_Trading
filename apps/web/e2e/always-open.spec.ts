// The simulated 24/7 stock session (D-76), end to end. Runs only in the always-open profile (SIM_SESSION=ALWAYS_OPEN, see
// run-all.mjs); the control at the same instant in the NYSE session is in sim-feed.spec.ts.
import { expect, test } from '@playwright/test';
import { control, counts, enterQty, reconcile, register } from './helpers';

const SUNDAY = '2026-11-15T12:00:00.000Z'; // a weekend: the real NYSE is closed

test.beforeEach(async () => {
  await control('/clock', { iso: SUNDAY });
  await control('/sim-refresh', {});
});

test('the banner says "Simulated 24/7 session" and a stock is tradable at a weekend instant', async ({
  page,
}) => {
  const { email } = await register(page);
  await expect(page.getByTestId('feed-banner')).toHaveText(
    'Simulated market data — not real prices · Simulated 24/7 session · Demo mode — virtual money, no real trading',
  );
  await page.goto('/instruments/AAPL');
  await expect(page.getByTestId('market-line')).toHaveAttribute('data-market-state', 'OPEN');
  await expect(page.getByTestId('market-line')).toContainText('Simulated 24/7 session');
  await expect(page.getByTestId('quote-panel').getByTestId('freshness-badge')).toHaveAttribute(
    'data-state',
    'REAL_TIME',
  );
  await enterQty(page, '2');
  await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('review-button').click();
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('result-filled')).toBeVisible();
  await expect(page.getByTestId('result-filled')).toContainText('(SIM)');
  expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
  expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
});

test('control: with DEMO_ACCOUNTS off there is no demo button on the login or the register page (M10, D-113)', async ({
  page,
}) => {
  for (const path of ['/login', '/register']) {
    await page.goto(path);
    await expect(page.locator('form').first()).toBeVisible();
    await expect(page.getByTestId('demo-button'), path).toHaveCount(0);
    await expect(page.getByTestId('demo-section'), path).toHaveCount(0);
  }
});
