// Prior close and day change in the UI (M7b T3): the quote panel and the search results show the change and its basis from
// the API's strings only. The e2e API runs the SIM feed with the NYSE session and an injected clock; /sim-refresh republishes
// the simulated quotes at that clock. Golden values: market-model candles.test.ts and sim.int.test.ts.
import { expect, test } from '@playwright/test';
import { control, register } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const M7B = '../../docs/phase-reports/m7b';
const MINUS = '−';

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await control('/sim-refresh', {});
});

test.describe('the quote panel', () => {
  test('a stock on the NYSE session: change against the previous close, exactly the API strings, with its basis', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/AAPL');
    // last 187.05, the previous session closed at 190.66: -3.61, -3.61 / 190.66 = -1.89 percent
    await expect(page.getByTestId('quote-last')).toHaveText('187.05');
    const change = page.getByTestId('quote-change');
    await expect(change).toContainText(`${MINUS}3.61 (${MINUS}1.89%)`);
    await expect(change).toHaveAttribute('data-direction', 'down');
    await expect(change).toContainText('▼');
    await expect(change).toHaveAttribute(
      'title',
      "Change since the previous regular session's close.",
    );
    await expect(page.getByTestId('quote-change-basis')).toHaveText('vs previous close');
    await page.screenshot({ path: `${M7B}/quote-change-stock-1280.png`, fullPage: true });
  });

  test('crypto: change against the price 24 hours ago (a different basis for the same panel)', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('quote-last')).toHaveText('75,459.99');
    const change = page.getByTestId('quote-change');
    await expect(change).toContainText('+3,364.25 (+4.67%)');
    await expect(change).toHaveAttribute('data-direction', 'up');
    await expect(change).toContainText('▲');
    await expect(change).toHaveAttribute('title', 'Change over the last 24 hours.');
    await expect(page.getByTestId('quote-change-basis')).toHaveText('24h');
    await page.screenshot({ path: `${M7B}/quote-change-crypto-1280.png`, fullPage: true });
    // the bases differ between the two kinds of instrument
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('quote-change-basis')).not.toHaveText('24h');
  });

  test('no prior data renders the dash, never 0: crypto a few hours into the history, and the first NYSE session of the year', async ({
    page,
  }) => {
    await control('/clock', { iso: '2026-01-01T12:00:00.000Z' }); // 24 hours earlier is before the history starts
    await control('/sim-refresh', {});
    await register(page);
    await page.goto('/instruments/BTC-USD');
    const change = page.getByTestId('quote-change');
    await expect(change).toHaveAttribute('data-direction', 'none');
    await expect(change).toContainText('—');
    await expect(change).not.toContainText('0.00');
    await expect(page.getByTestId('quote-change-basis')).toHaveText('no prior close yet');
    await expect(page.getByTestId('quote-bid')).not.toHaveText('—'); // the price itself is there

    await control('/clock', { iso: '2026-01-02T15:00:00.000Z' });
    await control('/sim-refresh', {});
    await page.goto('/instruments/AAPL');
    await expect(page.getByTestId('quote-change')).toContainText('—');
    await expect(page.getByTestId('quote-change')).not.toContainText('%');
  });
});

test.describe('search results', () => {
  test('each result shows its percentage change from the API: a loss for AAPL, a gain for Bitcoin', async ({
    page,
  }) => {
    await register(page);
    await page.keyboard.press('/');
    await page.keyboard.type('aapl');
    const first = page.getByTestId('search-option').first();
    await expect(first).toContainText('AAPL');
    await expect(first.getByTestId('search-change')).toContainText(`${MINUS}1.89%`);
    await expect(first.getByTestId('search-change')).toContainText('▼');
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await page.keyboard.type('bitcoin');
    const btc = page.getByTestId('search-option').first();
    await expect(btc).toContainText('BTC-USD');
    await expect(btc.getByTestId('search-change')).toContainText('+4.67%');
    await expect(btc.getByTestId('search-change')).toContainText('▲');
    await page.screenshot({ path: `${M7B}/search-change-1280.png` });
  });
});
