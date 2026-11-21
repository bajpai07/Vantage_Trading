// Orders, fills and account activity end to end: plain-language rejects, cursor "load more", honest empty states.
import { expect, test } from '@playwright/test';
import { BUY_AAPL_10, control, placeOrder, register, setQuote, shotPath } from './helpers';

test.beforeEach(async () => {
  await control('/clock', { iso: '2026-11-10T15:00:00.000Z' });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

test('a new account has honest empty states on both screens', async ({ page }) => {
  await register(page);
  await page.goto('/orders');
  await expect(page.getByTestId('empty-state')).toContainText('No orders yet');
  await page.goto('/activity');
  await expect(page.getByText('No fills yet')).toBeVisible();
  // the starting capital is real ledger activity even before any order
  await expect(page.getByTestId('activity-row')).toHaveCount(1);
  await expect(page.getByTestId('activity-row').first()).toContainText('Starting capital');
  await expect(page.getByTestId('cash-effect').first()).toContainText('+10,000.00');
});

test('orders show fills and rejects; every reject reads as a plain sentence, never a code', async ({
  page,
  context,
}) => {
  await register(page);
  await placeOrder(context, BUY_AAPL_10); // fills
  await placeOrder(context, { ...BUY_AAPL_10, qty: '5000' }); // INSUFFICIENT_BUYING_POWER
  await placeOrder(context, { ...BUY_AAPL_10, side: 'SELL', qty: '11', referencePrice: '189.95' }); // INSUFFICIENT_POSITION
  await placeOrder(context, { ...BUY_AAPL_10, referencePrice: '180.00' }); // PRICE_MOVED
  await setQuote('AAPL', '189.95', '190.00', { ageSeconds: 2000 });
  await placeOrder(context, BUY_AAPL_10); // STALE_QUOTE
  await setQuote('AAPL', '189.95', '190.00');

  await page.goto('/orders');
  const rows = page.getByTestId('order-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().getByTestId('reject-reason')).toContainText('too old to trade against');
  await expect(rows.nth(1).getByTestId('reject-reason')).toContainText(
    'moved more than 1% against you',
  );
  await expect(rows.nth(2).getByTestId('reject-reason')).toContainText('do not own enough shares');
  await expect(rows.nth(3).getByTestId('reject-reason')).toContainText('did not have enough cash');
  await expect(rows.nth(4)).toHaveAttribute('data-status', 'FILLED');
  await expect(rows.nth(4).getByTestId('order-result')).toContainText('10 @ 190.04');
  await expect(rows.nth(4).getByTestId('order-result')).toContainText('notional 1,900.40');
  const text = await page.getByTestId('orders-table').innerText();
  for (const code of [
    'STALE_QUOTE',
    'PRICE_MOVED',
    'INSUFFICIENT_POSITION',
    'INSUFFICIENT_BUYING_POWER',
  ]) {
    expect(text).not.toContain(code);
  }
  await expect(page.getByTestId('end-of-list')).toBeVisible();
  await page.screenshot({
    path: shotPath('../../docs/phase-reports/m6a/orders-1280.png'),
    fullPage: true,
  });
});

test('"load more" pages through 55 orders and 55 fills with no duplicates, newest first', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await register(page);
  // a cheap price, so 55 purchases fit in the 10,000 of starting cash (55 x 100.02 = 5,501.10)
  await setQuote('AAPL', '99.98', '100.00');
  for (let i = 0; i < 55; i += 1) {
    await placeOrder(context, { ...BUY_AAPL_10, qty: '1', referencePrice: '100.00' });
  }
  await page.goto('/orders');
  await expect(page.getByTestId('order-row')).toHaveCount(50);
  await page.getByTestId('load-more').click();
  await expect(page.getByTestId('order-row')).toHaveCount(55);
  await expect(page.getByTestId('load-more')).toHaveCount(0);
  await expect(page.getByTestId('end-of-list')).toBeVisible();

  await page.goto('/activity');
  await expect(page.getByTestId('execution-row')).toHaveCount(50);
  await page.getByTestId('load-more-executions').click();
  await expect(page.getByTestId('execution-row')).toHaveCount(55);
  // 55 fills plus the starting capital = 56 activity rows
  await expect(page.getByTestId('activity-row')).toHaveCount(50);
  await page.getByTestId('load-more-activity').click();
  await expect(page.getByTestId('activity-row')).toHaveCount(56);
  await expect(page.getByTestId('activity-row').last()).toContainText('Starting capital');
});

test('fills show the price used, the quote behind it and the realised result of a sale', async ({
  page,
  context,
}) => {
  await register(page);
  await placeOrder(context, BUY_AAPL_10);
  await setQuote('AAPL', '195.00', '195.05');
  await placeOrder(context, { ...BUY_AAPL_10, side: 'SELL', referencePrice: '195.00' });
  await page.goto('/activity');
  const fills = page.getByTestId('execution-row');
  await expect(fills).toHaveCount(2);
  await expect(fills.first()).toContainText('SELL');
  await expect(fills.first()).toContainText('194.96');
  await expect(fills.first().getByTestId('realised')).toContainText('+49.20'); // 10 x (194.96 - 190.04)
  await expect(fills.first()).toContainText('FIXTURE');
  await expect(fills.first()).toContainText('delayed');
  await expect(fills.nth(1).getByTestId('no-pnl')).toBeVisible(); // a purchase has no realised result
  const effects = page.getByTestId('cash-effect');
  await expect(effects.nth(0)).toContainText('+1,949.60'); // proceeds
  await expect(effects.nth(1)).toContainText('−1,900.40'); // cost, with a real minus sign
  await expect(effects.nth(1)).toHaveAttribute('data-direction', 'down');
  await page.screenshot({
    path: shotPath('../../docs/phase-reports/m6a/activity-1280.png'),
    fullPage: true,
  });
});
