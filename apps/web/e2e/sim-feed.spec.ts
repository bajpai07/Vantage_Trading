// The simulated feed end to end (M7a): per-source labelling, the demo banner and footer, a SIM stock order through the
// ticket with exact strings, and display-only crypto. The e2e API runs MARKET_DATA_SOURCE=SIM, CRYPTO_FEED=sim and
// DEMO_MODE=true with an injected clock; /sim-refresh republishes the real simulated quotes at that clock. No internet.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { apiGet, control, counts, enterQty, placeOrder, reconcile, register } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const M7A = '../../docs/phase-reports/m7a'; // screenshots

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await control('/sim-refresh', {});
});

test.describe('labelling: every price says where it comes from', () => {
  test('GET /v1/market/feed through the web proxy lists each class as SIMULATED, with demo mode on', async ({
    page,
  }) => {
    await register(page);
    const res = await page.request.get('/api/v1/market/feed');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      source: 'SIM',
      entitlement: 'REAL_TIME',
      enabled: true,
      demoMode: true,
    });
    expect(
      body.sources.map(
        (s: {
          assetClass: string;
          source: string;
          mode: string;
          status: string;
          session: string;
        }) => [s.assetClass, s.source, s.mode, s.status, s.session],
      ),
    ).toEqual([
      ['EQUITY', 'SIM', 'SIMULATED', 'CONNECTED', 'NYSE'],
      ['ETF', 'SIM', 'SIMULATED', 'CONNECTED', 'NYSE'],
      ['CRYPTO', 'SIM', 'SIMULATED', 'CONNECTED', '24_7'],
    ]);
  });

  test('the banner and the footer say simulated and demo, on the login page and inside the app', async ({
    page,
  }) => {
    const banner =
      'Simulated market data — not real prices · Demo mode — virtual money, no real trading';
    await page.goto('/login');
    await expect(page.getByTestId('feed-banner')).toHaveText(banner);
    await expect(page.getByTestId('demo-footer')).toContainText('This is a demo');
    await expect(page.getByTestId('feed-status-notice')).toHaveCount(0); // control: the feed is publishing
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('feed-banner')).toHaveText(banner);
    await expect(page.getByTestId('virtual-money-notice')).toContainText(
      'Virtual money — not real trading',
    );
    await expect(page.getByTestId('feed-banner').getByRole('button')).toHaveCount(0); // not dismissible
  });

  test('a feed that stops publishing says so (separate notice), and the notice goes away when it publishes again', async ({
    page,
  }) => {
    await register(page);
    await control('/clock', { iso: '2026-11-10T15:01:00.000Z' }); // a minute with no publish: the runner is "down"
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('feed-status-notice')).toContainText(
      'The stock and crypto price feed is not publishing right now',
    );
    await expect(page.getByTestId('feed-banner')).toHaveText(
      'Simulated market data — not real prices · Demo mode — virtual money, no real trading',
    ); // the banner itself still says what the data is
    await control('/sim-refresh', {});
    await page.reload();
    await expect(page.getByTestId('feed-status-notice')).toHaveCount(0);
  });
});

test.describe('a SIM stock, through the ticket (exact strings)', () => {
  test('AAPL at the simulated price: labelled SIM and REAL-TIME, buy 10 fills at the estimate; cash, position, quote_source SIM; reconciles clean', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    await page.goto('/instruments/AAPL');
    const panel = page.getByTestId('quote-panel');
    await expect(panel).toContainText('Source: SIM');
    await expect(panel.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'REAL_TIME');
    // the model's price at 2026-11-10T15:00:00Z for seed vantage-demo-1 (a hard-coded golden, see market-model sim.test.ts)
    await expect(page.getByTestId('quote-bid')).toHaveText('187.05');
    await expect(page.getByTestId('quote-ask')).toHaveText('187.06');
    await expect(page.getByTestId('quote-spread')).toHaveText('0.01');
    await expect(page.getByTestId('quote-age')).toHaveText('0 s ago');

    await enterQty(page, '10');
    await expect(page.getByTestId('estimate-price')).toHaveText('187.10', { timeout: 10_000 });
    await expect(page.getByTestId('estimate-notional')).toHaveText('1,871.00');
    await expect(page.getByTestId('estimate-cash-after')).toHaveText('8,129.00');
    await page.getByTestId('review-button').click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    await expect(page.getByTestId('result-price')).toHaveText('187.10');
    await expect(page.getByTestId('result-cash')).toHaveText('8,129.00');
    await expect(page.getByTestId('result-filled')).toContainText('(SIM)'); // the quote source of the fill
    await page.screenshot({ path: `${M7A}/sim-stock-filled-1280.png` });
    await page.getByTestId('result-close').click();
    await expect(page.getByTestId('position-qty')).toHaveText('10');
    await expect(page.getByTestId('position-avg-cost')).toHaveText('187.10');

    const orders = await apiGet<{
      orders: { status: string; execution: { quoteSource: string; price: string } }[];
    }>(context, '/v1/orders');
    expect(orders.orders[0]?.execution).toMatchObject({ quoteSource: 'SIM', price: '187.10' });
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('crypto is display-only until M8', () => {
  test('search finds it; the page shows live-labelled (SIM) quotes, the 24/7 market line, and Buy/Sell disabled with "not tradable yet"', async ({
    page,
  }) => {
    await register(page);
    await page.keyboard.press('/');
    await page.keyboard.type('bitcoin');
    const first = page.getByTestId('search-option').first();
    await expect(first).toContainText('BTC-USD');
    await expect(first).toContainText('Crypto');
    await first.click();
    await page.waitForURL('**/instruments/BTC-USD');

    await expect(page.getByTestId('instrument-name')).toContainText('Bitcoin');
    const panel = page.getByTestId('quote-panel');
    await expect(panel).toContainText('Source: SIM');
    await expect(panel.getByTestId('freshness-badge')).toHaveAttribute('data-state', 'REAL_TIME');
    await expect(page.getByTestId('quote-bid')).toHaveText('75,459.99');
    await expect(page.getByTestId('quote-ask')).toHaveText('75,460.00');
    await expect(page.getByTestId('market-line')).toHaveAttribute('data-market-state', 'OPEN');
    await expect(page.getByTestId('market-line')).toContainText('Crypto (simulated, 24/7) is open');

    // no estimate is even requested for something that cannot be traded
    const previews: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/orders/preview')) previews.push(r.url());
    });
    await enterQty(page, '1');
    const reason = page.getByTestId('ticket-reason');
    await expect(reason).toContainText('not tradable yet');
    await expect(page.getByTestId('review-button')).toBeDisabled();
    await page.locator('label:has([data-testid="side-sell"])').click();
    await expect(reason).toContainText('not tradable yet');
    await expect(page.getByTestId('review-button')).toBeDisabled();
    await page.waitForTimeout(800);
    expect(previews).toEqual([]);
    await page.screenshot({ path: `${M7A}/crypto-instrument-1280.png`, fullPage: true });

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
      [],
    );
  });

  test('forced through the API a crypto order is REJECTED (INSTRUMENT_NOT_TRADABLE) and nothing moves; the stock control fills', async ({
    page,
    context,
  }) => {
    const { email } = await register(page);
    const btc = await placeOrder(context, {
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: '75460.00',
    });
    expect(btc).toMatchObject({ status: 'REJECTED', rejectCode: 'INSTRUMENT_NOT_TRADABLE' });
    expect(await counts(email)).toEqual({ orders: '1', executions: '0' });
    const account = await apiGet<{ cash: string }>(context, '/v1/account');
    expect(account.cash).toMatch(/^10000(\.0+)?$/);
    await page.goto('/orders');
    await expect(page.getByTestId('order-row').first().getByTestId('reject-reason')).toContainText(
      'cannot be traded',
    );
    const aapl = await placeOrder(context, {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: '187.06',
    });
    expect(aapl).toMatchObject({ status: 'FILLED' });
    expect(await reconcile(email)).toEqual({ accounts: 1, violations: [] });
  });
});

test.describe('the NYSE session at a weekend instant (control for the 24/7 session)', () => {
  test('the same Sunday instant is CLOSED: the stock cannot be traded, the banner has no 24/7 text, crypto is still open', async ({
    page,
  }) => {
    await control('/clock', { iso: '2026-11-15T12:00:00.000Z' });
    await control('/sim-refresh', {});
    await register(page);
    await expect(page.getByTestId('feed-banner')).toHaveText(
      'Simulated market data — not real prices · Demo mode — virtual money, no real trading',
    );
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('market-line')).toHaveAttribute('data-market-state', 'CLOSED');
    await enterQty(page, '2');
    await expect(page.getByTestId('ticket-reason')).toContainText('market is closed');
    await expect(page.getByTestId('review-button')).toBeDisabled();
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('market-line')).toHaveAttribute('data-market-state', 'OPEN');
  });
});
