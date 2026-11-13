// Sessions and isolation end to end: logout and the back button, an expired or invalid session, and two users who
// must never see each other's data.
import { expect, test } from '@playwright/test';
import {
  API_ORIGIN,
  BUY_AAPL_10,
  WEB_ORIGIN,
  control,
  placeOrder,
  register,
  setQuote,
} from './helpers';

test.beforeEach(async () => {
  await control('/clock', { iso: '2026-11-10T15:00:00.000Z' });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

test.describe('4. logout, the back button and expired sessions', () => {
  test('after sign-out every protected page redirects, and the back button never shows private data', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await page.goto('/portfolio');
    await expect(page.getByTestId('position-row-AAPL')).toBeVisible();
    await page.goto('/orders');
    await expect(page.getByTestId('order-row')).toHaveCount(1);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login**');

    for (const path of ['/portfolio', '/orders', '/activity']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
    // back button: walk back through the history; nothing private may be rendered at any step
    for (let i = 0; i < 4; i += 1) {
      await page.goBack().catch(() => undefined);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByTestId('position-row-AAPL')).toHaveCount(0);
      await expect(page.getByTestId('order-row')).toHaveCount(0);
      await expect(page.getByTestId('user-name')).toHaveCount(0);
      expect(await page.content()).not.toContain('190.04');
    }
  });

  test('a tampered or unknown session cookie is treated as no session', async ({
    page,
    context,
  }) => {
    await register(page);
    await context.clearCookies();
    await context.addCookies([
      {
        name: 'vantage_session',
        value: 'not-a-real-session-token',
        url: WEB_ORIGIN,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto('/portfolio');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('a session that expires while the portfolio is open sends you to the login page with a clear note', async ({
    page,
    context,
  }) => {
    await register(page);
    await expect(page.getByTestId('portfolio')).toBeVisible();
    await context.clearCookies(); // the session is gone; the next poll gets 401
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByTestId('notice')).toContainText(
      'Your session has expired. Please sign in again.',
    );
  });
});

test.describe("5. isolation: another user's data never appears", () => {
  test("two browser contexts: B sees an empty portfolio, no orders, no activity of A; the API answers 404 for A's order", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await register(pageA, { displayName: 'Alice Anderson' });
      await register(pageB, { displayName: 'Bob Brown' });
      const order = await placeOrder(ctxA, BUY_AAPL_10);

      // A sees their own data
      await pageA.goto('/portfolio');
      await expect(pageA.getByTestId('position-row-AAPL')).toBeVisible();
      await expect(pageA.getByTestId('user-name')).toHaveText('Alice Anderson');

      // B sees none of it
      await pageB.goto('/portfolio');
      await expect(pageB.getByTestId('user-name')).toHaveText('Bob Brown');
      await expect(pageB.getByTestId('empty-state')).toBeVisible();
      await expect(pageB.getByTestId('metric-cash')).toContainText('10,000.00');
      await pageB.goto('/orders');
      await expect(pageB.getByTestId('empty-state')).toContainText('No orders yet');
      await pageB.goto('/activity');
      await expect(pageB.getByText('No fills yet')).toBeVisible();
      await expect(pageB.getByTestId('activity-row')).toHaveCount(1); // only B's own starting capital
      const html = await pageB.content();
      expect(html).not.toContain('Alice');
      expect(html).not.toContain(String(order.id).slice(-8));

      // B's session cannot read A's order, and the answer does not reveal that it exists
      const orderId = String(order.id);
      const asB = await ctxB.request.get(`${API_ORIGIN}/v1/orders/${orderId}`);
      const missing = await ctxB.request.get(
        `${API_ORIGIN}/v1/orders/0198d0d0-1111-7000-8000-000000000099`,
      );
      expect(asB.status()).toBe(404);
      expect(missing.status()).toBe(404);
      expect((await asB.json()).error.code).toBe((await missing.json()).error.code);
      // control: A can
      expect((await ctxA.request.get(`${API_ORIGIN}/v1/orders/${orderId}`)).status()).toBe(200);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
