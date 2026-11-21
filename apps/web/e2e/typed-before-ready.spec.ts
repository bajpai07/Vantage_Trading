// M9a T0b (carry-over of M8b-1 F5): is a quantity typed right after navigation, before the page has hydrated, kept?
// The page is loaded with CPU throttling (Chrome DevTools Emulation.setCPUThrottlingRate 4x and 6x); the keystrokes start as soon as
// the server-rendered quantity input is in the DOM, i.e. as early as a fast typist could, and the field is read back once the page
// is interactive. The same test is the regression test of the fix.
import { expect, test } from '@playwright/test';
import { control, register, setQuote } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const ATTEMPTS = 20;
const TYPED = '0.0015';

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('BTC-USD', '89990.00', '90010.00');
});

for (const rate of [4, 6]) {
  test(`${String(ATTEMPTS)} attempts at ${String(rate)}x CPU throttling: the quantity typed before hydration is kept`, async ({
    page,
    context,
  }) => {
    test.setTimeout(600_000);
    await register(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const lost: string[] = [];
    let early = 0; // attempts whose first keystroke really came before React had hydrated the input
    for (let i = 0; i < ATTEMPTS; i += 1) {
      await page.goto('/instruments/BTC-USD', { waitUntil: 'commit' });
      const input = page.getByTestId('ticket-qty');
      await input.waitFor({ state: 'attached', timeout: 60_000 });
      const hydratedAtStart = await input.evaluate((el) =>
        Object.keys(el).some((k) => k.startsWith('__reactProps')),
      );
      if (!hydratedAtStart) early += 1;
      await input.pressSequentially(TYPED, { delay: 0 });
      // let hydration and the first effects finish, then look at what the field and the form say
      await page.waitForLoadState('load');
      await page.waitForTimeout(1500);
      const value = await input.inputValue();
      if (value !== TYPED) lost.push(`attempt ${String(i + 1)}: field is "${value}"`);
      // the form STATE has the quantity too, not only the DOM field: the preview is requested and Review becomes enabled
      const enabled = await page
        .getByTestId('review-button')
        .isEnabled({ timeout: 1000 })
        .catch(() => false);
      if (value === TYPED && !enabled) {
        await expect(page.getByTestId('review-button'))
          .toBeEnabled({ timeout: 20_000 })
          .catch(() => {
            lost.push(
              `attempt ${String(i + 1)}: the field shows the quantity but Review never became enabled`,
            );
          });
      }
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    process.stdout.write(
      `TYPED_BEFORE_READY rate=${String(rate)} lost=${String(lost.length)}/${String(ATTEMPTS)} typedBeforeHydration=${String(early)}/${String(ATTEMPTS)} ${lost.join('; ')}\n`,
    );
    expect(lost).toEqual([]);
    // and the form really has the quantity (the review button follows the state, not only the DOM)
    await page.goto('/instruments/BTC-USD');
    await page.getByTestId('ticket-qty').fill(TYPED);
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
  });
}
