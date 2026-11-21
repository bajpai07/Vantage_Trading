// M9b end to end on phone-sized, touch-enabled browsers (Chromium emulation: the iPhone 13 and Pixel 7 sizes and user agents, a small
// 360x640 phone, a landscape phone, a portrait tablet). Quotes are pinned through the control server (BTC-USD bid 89,990.00 / ask
// 90,010.00). Every flow also listens for `securitypolicyviolation` events: zero are expected. REAL soft-keyboard behaviour, real
// touch hardware and real iOS Safari are NOT covered here (listed as UNVERIFIED in the report).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { control, counts, register, setQuote, shotPath } from './helpers';

const OPEN = '2026-11-10T15:00:00.000Z';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface Device {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dsf: number;
  readonly ua?: string;
}
const DEVICES: readonly Device[] = [
  { name: 'iPhone 13 (390x844)', width: 390, height: 844, dsf: 3, ua: IPHONE_UA },
  { name: 'Pixel 7 (412x915)', width: 412, height: 915, dsf: 2.625 },
  { name: 'small phone (360x640)', width: 360, height: 640, dsf: 2 },
  { name: 'landscape phone (844x390)', width: 844, height: 390, dsf: 3, ua: IPHONE_UA },
  { name: 'tablet portrait (768x1024)', width: 768, height: 1024, dsf: 2 },
];
const IPHONE = DEVICES[0] as Device;
const SMALL = DEVICES[2] as Device;

const useDevice = (d: Device): void =>
  test.use({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dsf,
    isMobile: true,
    hasTouch: true,
    ...(d.ua === undefined ? {} : { userAgent: d.ua }),
  });

test.beforeEach(async () => {
  await control('/clock', { iso: OPEN });
  await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90000.00' });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

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

async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[data-testid="price-chart-canvas"]')
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

async function openInstrument(page: Page, symbol = 'BTC-USD'): Promise<void> {
  await page.goto(`/instruments/${symbol}`);
  await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('phone-action-bar')).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width - 1 &&
  b.x < a.x + a.width - 1 &&
  a.y < b.y + b.height - 1 &&
  b.y < a.y + a.height - 1;

/** Layout facts of the page as it is now (called at the top and again after scrolling to the bottom). */
async function facts(page: Page): Promise<{
  overflow: number;
  banner: { top: number; covered: boolean } | null;
}> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const text = document.querySelector('[data-testid="feed-banner"]');
    const b = text === null ? null : (text.closest('[role="status"]') ?? text); // the whole amber bar
    let banner: { top: number; covered: boolean } | null = null;
    if (b !== null) {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      banner = { top: r.top, covered: hit === null || !b.contains(hit) };
    }
    return { overflow: de.scrollWidth - de.clientWidth, banner };
  });
}

/** Primary controls present on the page must be at least 44 x 44 CSS px (D-109). */
async function touchTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = [
      'nav[aria-label="Primary"] a',
      '[role="tab"]',
      '[data-testid="action-buy"]',
      '[data-testid="action-sell"]',
      '[data-testid="cancel-button"]',
      '[data-testid="watchlist-open"]',
      '[data-testid="sheet-close"]',
      '[data-testid="review-button"]',
      '[data-testid="confirm-button"]',
      '[data-testid="depth-show-more"]',
      '[data-testid="watch-link"]',
    ].join(',');
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // not shown
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5)
        bad.push(
          `${el.getAttribute('data-testid') ?? el.tagName} "${(el.textContent ?? '').trim().slice(0, 20)}" ${String(Math.round(r.width))}x${String(Math.round(r.height))}`,
        );
    }
    return bad;
  });
}

async function checkPage(page: Page, label: string, device: Device, phone: boolean): Promise<void> {
  const top = await facts(page);
  expect(top.overflow, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  expect(top.banner, `${label}: the simulated-data bar is shown`).not.toBeNull();
  expect(top.banner?.top ?? 99, `${label}: the bar is at the top`).toBeLessThanOrEqual(1);
  expect(top.banner?.covered, `${label}: the bar is not covered`).toBe(false);
  if (phone) expect(await touchTargets(page), `${label}: touch targets`).toEqual([]);
  if (phone) {
    // text inputs are at least 16 px (iOS does not zoom on focus); pinch-zoom itself stays allowed (the viewport meta)
    const small = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea',
        ),
      )
        .filter((e) => e.getClientRects().length > 0)
        .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16)
        .map(
          (e) =>
            (e.getAttribute('data-testid') ?? e.getAttribute('name') ?? e.tagName) +
            ' ' +
            getComputedStyle(e).fontSize,
        ),
    );
    expect(small, `${label}: inputs under 16 px`).toEqual([]);
    const meta = await page.evaluate(
      () => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    );
    expect(meta).toContain('viewport-fit=cover');
    expect(meta).not.toContain('user-scalable=no');
    expect(meta).not.toContain('maximum-scale');
  }
  // scrolled to the bottom: the fixed bars cover neither the footer link nor the last block
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  const link = page.getByTestId('notices-link');
  await expect(link, `${label}: footer link`).toBeVisible();
  // the link may wrap over two lines: probe the middle of its first line box
  const covering = await page.evaluate(() => {
    const a = document.querySelector('a[data-testid="notices-link"]') as HTMLElement;
    const r = a.getClientRects()[0] as DOMRect;
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el === null
      ? 'none'
      : el.closest('a[data-testid="notices-link"]') === null
        ? el.tagName + ' ' + (el.getAttribute('data-testid') ?? '')
        : 'ok';
  });
  expect(covering, `${label}: the footer link is not covered by a bar`).toBe('ok');
  const bars = await page.evaluate(() => {
    const out: Box[] = [];
    for (const sel of ['nav[aria-label="Primary"]', '[data-testid="phone-action-bar"]']) {
      const el = document.querySelector(sel);
      if (el === null) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && getComputedStyle(el).display !== 'none')
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    }
    return out;
  });
  // the last content block of every page is the footer text; the sticky action bar only stays in place while content is behind it
  const footer = (await page.getByTestId('virtual-money-notice').boundingBox()) as Box;
  const text = { x: footer.x, y: footer.y, width: footer.width, height: footer.height - 64 }; // the footer keeps 4rem free for the bars
  for (const b of bars)
    expect(intersects(text, b), `${label}: a fixed bar covers the footer text`).toBe(false);
  void device;
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const device of DEVICES) {
  test.describe(`layout on ${device.name}`, () => {
    useDevice(device);
    const phone = device.width < 768;

    test('every page: no horizontal scroll, the bar visible, bars never cover content, touch targets', async ({
      page,
      context,
    }) => {
      test.setTimeout(180_000);
      await watchCsp(context);
      // signed-out pages
      for (const [path, label] of [
        ['/login', 'login'],
        ['/register', 'register'],
        ['/third-party-notices', 'notices'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByTestId('notices-link')).toBeVisible();
        await checkPage(page, `${device.name} ${label}`, device, phone);
      }
      await register(page);
      for (const [path, ready, label] of [
        ['/portfolio', 'metric-cash', 'portfolio'],
        ['/orders', 'orders-table', 'orders'],
        ['/activity', 'virtual-money-notice', 'activity'],
        ['/instruments/ZZZNOPE', 'not-found', 'not found'],
        ['/instruments/BTC-USD', 'chart-ready', 'instrument'],
      ] as const) {
        await page.goto(path);
        if (label === 'orders') await page.waitForTimeout(500);
        else await expect(page.getByTestId(ready)).toBeVisible({ timeout: 20_000 });
        await checkPage(page, `${device.name} ${label}`, device, phone);
      }
      expect(await violations(page)).toEqual([]);
    });
  });
}

test.describe('the bottom sheet on an iPhone 13', () => {
  useDevice(IPHONE);

  test('opens from Buy and from Sell with the side preset; dialog semantics; focus in, Tab trapped; Esc, Close and a backdrop tap return focus to the opener', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await openInstrument(page);
    const sheet = page.getByTestId('ticket-sheet');
    await expect(sheet).toHaveAttribute('data-open', 'false');
    await expect(sheet).not.toBeVisible(); // closed: not on screen and not focusable

    for (const [button, side] of [
      ['action-buy', 'side-buy'],
      ['action-sell', 'side-sell'],
    ] as const) {
      const opener = page.getByTestId(button);
      await opener.tap();
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('role', 'dialog');
      await expect(sheet).toHaveAttribute('aria-modal', 'true');
      await expect(sheet).toHaveAttribute('aria-labelledby', 'ticket-title');
      await expect(page.getByTestId(side)).toBeChecked(); // the side is preset
      // focus is inside, and Tab stays inside however often it is pressed
      await expect
        .poll(() => sheet.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
      for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press('Tab');
        expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      // the sheet fits: at most 92 % of the screen high
      const box = (await sheet.boundingBox()) as Box;
      expect(box.height).toBeLessThanOrEqual(IPHONE.height * 0.92 + 1);
      // Esc closes it and focus returns to the control that opened it
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveAttribute('data-open', 'false');
      await expect(opener).toBeFocused();
      // the Close button does the same
      await opener.tap();
      await page.getByTestId('sheet-close').tap();
      await expect(sheet).toHaveAttribute('data-open', 'false');
      await expect(opener).toBeFocused();
      // and so does a tap on the backdrop
      await opener.tap();
      await expect(sheet).toBeVisible();
      await page.getByTestId('sheet-backdrop').tap({ position: { x: 20, y: 20 } });
      await expect(sheet).toHaveAttribute('data-open', 'false');
      await expect(opener).toBeFocused();
    }
    expect(await violations(page)).toEqual([]);
  });

  test('a market buy through the sheet shows the exact vector strings; a double tap on Confirm creates one order; Close is disabled while the order is being sent', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    const { email } = await register(page);
    await openInstrument(page);
    await page.getByTestId('action-buy').tap();
    await page.getByTestId('ticket-qty').fill('0.0025');
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('review-button').tap();
    await expect(page.getByTestId('ticket-dialog')).toBeVisible();
    // slow the answer down so the in-flight state can be looked at
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      },
    );
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/orders')
        posts.push(r.headers()['idempotency-key'] ?? '');
    });
    await page.getByTestId('confirm-button').dblclick(); // two quick taps
    // while it is being sent the sheet cannot be closed, and says why (the review dialog covers it: read the DOM)
    await expect(page.getByTestId('sheet-close')).toBeDisabled();
    await expect(page.getByTestId('sheet-locked-reason')).toHaveText(
      'Your order is being sent. You can close this when it finishes.',
    );
    await expect(page.getByTestId('result-filled')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('result-price')).toHaveText('90,055.01');
    await expect(page.getByTestId('result-cash')).toHaveText('9,774.63733748');
    expect(posts).toHaveLength(1); // one order, one key
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
    await page.getByTestId('result-close').tap();
    await expect(page.getByTestId('ticket-sheet')).toHaveAttribute('data-open', 'false'); // the result is closed: so is the sheet
    expect(await violations(page)).toEqual([]);
  });

  test('a network failure leaves "Retry safely" with the SAME key after hiding the dialog, closing and reopening the sheet; still exactly one order', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    const { email } = await register(page);
    await openInstrument(page);
    const keys: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/orders')
        keys.push(r.headers()['idempotency-key'] ?? '');
    });
    let first = true;
    await page.route(
      (u) => u.pathname === '/api/v1/orders',
      async (route) => {
        if (route.request().method() === 'POST' && first) {
          first = false;
          await route.fetch(); // the API places the order ...
          await route.abort('connectionreset'); // ... and the answer is lost
        } else await route.continue();
      },
    );
    await page.getByTestId('action-buy').tap();
    await page.getByTestId('ticket-qty').fill('0.001');
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('review-button').tap();
    await page.getByTestId('confirm-button').tap();
    await expect(page.getByTestId('retry-notice')).toBeVisible();
    await expect(page.getByTestId('confirm-button')).toHaveText('Retry safely');
    // dismiss: the dialog is hidden, the attempt is kept; close the sheet; open it again
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ticket-dialog')).toBeHidden();
    await page.getByTestId('sheet-close').tap();
    await expect(page.getByTestId('ticket-sheet')).toHaveAttribute('data-open', 'false');
    await page.getByTestId('action-buy').tap();
    await expect(page.getByTestId('confirm-button')).toHaveText('Retry safely');
    await page.getByTestId('confirm-button').tap();
    await expect(page.getByTestId('result-filled')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]); // the same idempotency key
    expect(await counts(email)).toEqual({ orders: '1', executions: '1' });
    expect(await violations(page)).toEqual([]);
  });

  test('a resting limit order through the sheet, then Cancel from the phone Orders panel returns the exact reserved amount', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await openInstrument(page);
    await page.getByTestId('action-buy').tap();
    await page.locator('label:has([data-testid="kind-limit"])').tap();
    await page.getByTestId('ticket-qty').fill('0.0025');
    await page.getByTestId('ticket-limit').fill('89900.00');
    await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('review-button').tap();
    await page.getByTestId('confirm-button').tap();
    await expect(page.getByTestId('result-accepted')).toBeVisible();
    await expect(page.getByTestId('result-reserved')).toHaveText('224.97475');
    await page.getByTestId('result-close').tap();
    await expect(page.getByTestId('ticket-sheet')).toHaveAttribute('data-open', 'false');
    // the phone Orders panel lists it with a Cancel button
    const tab = page.getByTestId('bottom-tab-open');
    await expect(tab).toHaveText('Orders (1)', { timeout: 20_000 });
    await tab.tap();
    await expect(page.getByTestId('open-order-row')).toHaveCount(1);
    await page.getByTestId('cancel-button').tap();
    await expect(page.getByTestId('cancel-notice')).toContainText(
      'Cancelled. 224.97475 is back in your cash.',
    );
    await expect(tab).toHaveText('Orders (0)', { timeout: 20_000 });
    expect(await violations(page)).toEqual([]);
  });

  test('a tap on a book price opens the sheet in Limit mode with that price string', async ({
    page,
  }) => {
    await register(page);
    await openInstrument(page);
    await expect(page.getByTestId('depth-ready')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('depth-bid-row')).toHaveCount(8); // 8 levels on a phone
    await page.getByTestId('depth-bid-row').nth(2).getByTestId('depth-price').tap();
    await expect(page.getByTestId('ticket-sheet')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('kind-limit')).toBeChecked();
    await expect(page.getByTestId('ticket-limit')).toHaveValue('89970.72');
  });
});

test.describe('the soft keyboard (emulated: the viewport is shrunk while a field is focused)', () => {
  useDevice(SMALL);

  test('the sheet stays inside the visible area, the Review button is reachable inside it, and the page behind does not move', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await openInstrument(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.getByTestId('action-buy').tap();
    await page.getByTestId('ticket-qty').focus();
    // a soft keyboard takes about half of the screen: the browser reports a smaller visual viewport
    await page.setViewportSize({ width: SMALL.width, height: 340 });
    await page.waitForTimeout(400);
    const sheet = page.getByTestId('ticket-sheet');
    const vv = await page.evaluate(() => ({
      h: window.visualViewport?.height ?? 0,
      inner: window.innerHeight,
    }));
    expect(vv.h).toBeGreaterThan(0);
    const box = (await sheet.boundingBox()) as Box;
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height).toBeLessThanOrEqual(vv.inner + 1); // never below the visible area
    // the viewport numbers reached the sheet as CSS custom properties (set through the CSSOM, no style attribute)
    const prop = await sheet.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--vv-h'));
    expect(prop).toMatch(/px$/);
    expect(await sheet.getAttribute('style')).not.toBeNull(); // the CSSOM wrote it after load; the markup had none
    // the Review button is reachable by scrolling INSIDE the sheet
    await page.getByTestId('review-button').scrollIntoViewIfNeeded();
    const rb = (await page.getByTestId('review-button').boundingBox()) as Box;
    expect(rb.y).toBeGreaterThanOrEqual(0);
    expect(rb.y + rb.height).toBeLessThanOrEqual(vv.inner + 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore); // the page behind did not move
    // closing the sheet removes the properties again
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveAttribute('data-open', 'false');
    expect(await sheet.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--vv-h'))).toBe(
      '',
    );
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the chart and the page scroll on a touch screen', () => {
  useDevice(IPHONE);

  test('a vertical swipe that starts on the chart scrolls the page (control: a swipe on the page does too)', async ({
    page,
  }) => {
    await register(page);
    await openInstrument(page);
    const cdp = await page.context().newCDPSession(page);
    // a real touch sequence (touchStart, a run of touchMove, touchEnd) through the DevTools protocol
    const swipe = async (x: number, y: number): Promise<number> => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 12; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - i * 20 }],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(500);
      return page.evaluate(() => window.scrollY);
    };
    const canvas = (await page
      .locator('[data-testid="price-chart-canvas"] canvas')
      .first()
      .boundingBox()) as Box;
    process.stdout.write(`TOUCH_ACTION ${await page.evaluate(() => {
      const c = document.querySelector('[data-testid="price-chart-canvas"] canvas');
      return [c, c?.parentElement, c?.parentElement?.parentElement]
        .map((e) => (e === null || e === undefined ? 'none' : getComputedStyle(e).touchAction))
        .join(' | ');
    })}
`);
    const fromChart = await swipe(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    const fromHeader = await swipe(IPHONE.width / 2, 40);
    process.stdout.write(`SWIPE chart=${String(fromChart)} header=${String(fromHeader)}
`);
    expect(fromHeader).toBeGreaterThan(50); // control: a swipe on the page scrolls it
    expect(fromChart).toBeGreaterThan(50); // the page moved although the finger started on the chart
    // panning the chart sideways with a finger is a library gesture: checked by hand on a device (see the report)
  });

  test('tapping a candle shows its exact strings in the legend (no hover needed)', async ({
    page,
  }) => {
    await register(page);
    await openInstrument(page);
    const canvas = page.locator('[data-testid="price-chart-canvas"] canvas').first();
    const b = (await canvas.boundingBox()) as Box;
    const before = await page.getByTestId('legend-time').innerText();
    await page.touchscreen.tap(b.x + b.width * 0.3, b.y + b.height * 0.4);
    await expect.poll(async () => page.getByTestId('legend-time').innerText()).not.toBe(before);
    await expect(page.getByTestId('legend-c')).toHaveText(/^[\d,]+\.\d+$/);
  });
});

test.describe('the segmented panels and the watchlist drawer', () => {
  useDevice(IPHONE);

  test('Book | Positions | Orders | History: one panel at a time; the book starts with 8 levels and shows more; counts match the server', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await openInstrument(page);
    const tabs = page.getByRole('tablist', { name: 'Positions and orders' });
    await expect(tabs.getByRole('tab')).toHaveText(['Book', 'Positions (0)', /Orders/, 'History']);
    await expect(tabs.getByRole('tab', { name: 'Book' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('bottom-panel-book')).toBeVisible();
    await expect(page.getByTestId('bottom-panel-positions')).toBeHidden();
    await expect(page.getByTestId('depth-honesty')).toBeVisible(); // the honesty label stays
    await expect(page.getByTestId('depth-ask-row')).toHaveCount(8);
    await page.getByTestId('depth-show-more').tap();
    await expect(page.getByTestId('depth-ask-row')).toHaveCount(15);
    await page.getByTestId('depth-show-more').tap();
    await expect(page.getByTestId('depth-ask-row')).toHaveCount(25);
    await expect(page.getByTestId('depth-show-more')).toHaveCount(0); // nothing more to show
    for (const [name, shown] of [
      ['Positions (0)', 'bottom-panel-positions'],
      ['History', 'bottom-panel-history'],
      ['Book', 'bottom-panel-book'],
    ] as const) {
      await tabs.getByRole('tab', { name }).tap();
      await expect(page.getByTestId(shown)).toBeVisible();
      for (const other of [
        'bottom-panel-book',
        'bottom-panel-positions',
        'bottom-panel-open',
        'bottom-panel-history',
      ]) {
        const loc = page.getByTestId(other);
        if (other !== shown && (await loc.count()) > 0) await expect(loc).toBeHidden();
      }
    }
    const res = await page.request.get('/api/v1/orders?status=open&limit=100');
    const open = ((await res.json()) as { orders: unknown[] }).orders.length;
    await expect(
      tabs.getByRole('tab', { name: new RegExp(`Orders \\(${String(open)}\\)`) }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('the watchlist drawer: a dialog; selecting a row navigates and closes it; stars persist; Esc closes it', async ({
    page,
    context,
  }) => {
    await watchCsp(context);
    await register(page);
    await openInstrument(page);
    await expect(page.getByTestId('terminal-rail')).toBeHidden(); // no rail on a phone
    const open = page.getByTestId('watchlist-open');
    await open.tap();
    const drawer = page.getByTestId('watchlist-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveJSProperty('open', true);
    await expect
      .poll(() => drawer.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await expect(page.getByTestId('watch-row')).toHaveCount(9);
    await expect(page.getByTestId('watch-saved-note')).toHaveText('Saved in this browser');
    await page.getByTestId('watch-row').filter({ hasText: 'NVDA' }).getByTestId('watch-star').tap(); // un-star
    await expect(page.getByTestId('watch-row')).toHaveCount(8);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();
    await open.tap();
    await page.getByTestId('watch-row').filter({ hasText: 'MSFT' }).getByTestId('watch-link').tap();
    await expect(page).toHaveURL(/\/instruments\/MSFT$/);
    await expect(drawer).toBeHidden(); // choosing a symbol closes it
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await page.getByTestId('watchlist-open').tap();
    await expect(page.getByTestId('watch-row')).toHaveCount(8); // the star persisted
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('accessibility on a phone (serious and critical violations are zero)', () => {
  for (const d of [IPHONE, SMALL]) {
    test.describe(d.name, () => {
      useDevice(d);
      test('instrument loaded and stale, sheet (form, review, result), drawer, portfolio, orders, login', async ({
        page,
        context,
      }) => {
        test.setTimeout(180_000);
        await watchCsp(context);
        await page.goto('/login');
        expect(await serious(page), 'login').toEqual([]);
        await register(page);
        await openInstrument(page);
        expect(await serious(page), 'instrument loaded').toEqual([]);
        await page.getByTestId('action-buy').tap();
        await page.getByTestId('ticket-qty').fill('0.001');
        await expect(page.getByTestId('review-button')).toBeEnabled({ timeout: 10_000 });
        expect(await serious(page), 'sheet: form').toEqual([]);
        await page.getByTestId('review-button').tap();
        await expect(page.getByTestId('ticket-dialog')).toBeVisible();
        expect(await serious(page), 'sheet: review').toEqual([]);
        await page.getByTestId('confirm-button').tap();
        await expect(page.getByTestId('result-filled')).toBeVisible();
        expect(await serious(page), 'sheet: result').toEqual([]);
        await page.getByTestId('result-close').tap();
        await page.getByTestId('watchlist-open').tap();
        await expect(page.getByTestId('watch-row').first()).toBeVisible();
        expect(await serious(page), 'watchlist drawer').toEqual([]);
        await page.keyboard.press('Escape');
        await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90000.00', ageSeconds: 3600 });
        await expect(page.getByTestId('chart-unavailable')).toBeVisible({ timeout: 20_000 });
        expect(await serious(page), 'instrument stale').toEqual([]);
        await setQuote('BTC-USD', '89990.00', '90010.00', { last: '90000.00' });
        await page.goto('/portfolio');
        await expect(page.getByTestId('metric-cash')).toBeVisible();
        expect(await serious(page), 'portfolio').toEqual([]);
        await page.goto('/orders');
        await expect(page.getByTestId('orders-table')).toBeVisible();
        expect(await serious(page), 'orders').toEqual([]);
        expect(await violations(page)).toEqual([]);
      });
    });
  }
});

test.describe('motion: the sheet slides only when the user allows motion', () => {
  useDevice(IPHONE);
  const duration = (page: Page): Promise<string> =>
    page.getByTestId('ticket-sheet').evaluate((el) => getComputedStyle(el).transitionDuration);

  test('reduced motion: no transition (control: with motion allowed there is one)', async ({
    page,
  }) => {
    await register(page);
    await openInstrument(page);
    expect(await duration(page)).toContain('0.22s'); // motion allowed: the slide transition is in effect
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(['0s', '1e-05s']).toContain(await duration(page)); // reduced motion: none (the global rule makes it 0.01 ms)
  });
});

test.describe('screenshots (written to docs/phase-reports/m9b only with UPDATE_SCREENSHOTS=1)', () => {
  test.describe('iPhone 13', () => {
    useDevice(IPHONE);
    test('instrument closed and with the sheet open, orders, portfolio, the drawer', async ({
      page,
    }) => {
      await register(page);
      await openInstrument(page);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: shotPath('../../docs/phase-reports/m9b/instrument-390.png') });
      await page.getByTestId('action-buy').tap();
      await page.waitForTimeout(500);
      await page.screenshot({ path: shotPath('../../docs/phase-reports/m9b/sheet-390.png') });
      await page.keyboard.press('Escape');
      await page.getByTestId('watchlist-open').tap();
      await page.waitForTimeout(700);
      await page.screenshot({ path: shotPath('../../docs/phase-reports/m9b/drawer-390.png') });
      await page.keyboard.press('Escape');
      await page.goto('/orders');
      await page.waitForTimeout(800);
      await page.screenshot({ path: shotPath('../../docs/phase-reports/m9b/orders-390.png') });
      await page.goto('/portfolio');
      await page.waitForTimeout(800);
      await page.screenshot({ path: shotPath('../../docs/phase-reports/m9b/portfolio-390.png') });
    });
  });
  test.describe('landscape', () => {
    useDevice(DEVICES[3] as Device);
    test('instrument in landscape', async ({ page }) => {
      await register(page);
      await openInstrument(page).catch(() => undefined);
      await page.goto('/instruments/BTC-USD');
      await page.waitForTimeout(2500);
      await page.screenshot({
        path: shotPath('../../docs/phase-reports/m9b/landscape-844x390.png'),
      });
    });
  });
});

test.describe('performance of the phone instrument page (reported, not gates)', () => {
  useDevice(IPHONE);
  test('CLS, LCP, and the requests of 30 idle seconds', async ({ page }) => {
    await register(page);
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
    await page.goto('/instruments/BTC-USD');
    await expect(page.getByTestId('chart-ready')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3000);
    const vitals = await page.evaluate(() => {
      const w = window as unknown as { __cls: number; __lcp: number };
      return { cls: w.__cls, lcp: w.__lcp };
    });
    const counts30 = new Map<string, number>();
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/'))
        counts30.set(
          u.pathname.replace('/api', ''),
          (counts30.get(u.pathname.replace('/api', '')) ?? 0) + 1,
        );
    });
    await page.waitForTimeout(30_000);
    const total = [...counts30.values()].reduce((a, b) => a + b, 0);
    process.stdout.write(
      `PHONE_PERF ${JSON.stringify(vitals)} idle30s total=${String(total)} ${JSON.stringify(Object.fromEntries([...counts30.entries()].sort()))}\n`,
    );
    expect(vitals.cls).toBeLessThan(0.1);
  });
});
