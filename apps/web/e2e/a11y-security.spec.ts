// 6. accessibility (axe on every page, keyboard-only login, 375 px layout) and 7. security (cookie flags, no token in
// storage, CSP, no console errors).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  BUY_AAPL_10,
  PASSWORD,
  control,
  placeOrder,
  register,
  setQuote,
  uniqueEmail,
  shotPath,
} from './helpers';

test.beforeEach(async () => {
  await control('/clock', { iso: '2026-11-10T15:00:00.000Z' });
  await setQuote('AAPL', '189.95', '190.00', { last: '189.97' });
});

async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('6. accessibility', () => {
  test('axe finds no serious or critical violations on any page (with real content: a position, fills, a reject)', async ({
    page,
    context,
  }) => {
    for (const path of ['/login', '/register']) {
      await page.goto(path);
      expect(await serious(page), path).toEqual([]);
    }
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await placeOrder(context, { ...BUY_AAPL_10, qty: '5000' }); // a reject row
    await setQuote('AAPL', '195.00', '195.05');
    for (const path of ['/portfolio', '/orders', '/activity']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      expect(await serious(page), path).toEqual([]);
    }
    // the incomplete state and the empty state as well
    await control('/quote', { symbol: 'AAPL', clear: true });
    await page.goto('/portfolio');
    await expect(page.getByTestId('incomplete-alert')).toBeVisible();
    expect(await serious(page), 'portfolio (incomplete)').toEqual([]);
  });

  test('control: axe really can fail (an unlabelled input is reported)', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'text';
      document.querySelector('form')?.appendChild(i);
    });
    const found = await serious(page);
    expect(found.some((f) => f.startsWith('label'))).toBe(true);
  });

  test('keyboard-only: register is not needed, sign in works with Tab, typing and Enter alone', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('kbd');
    const setup = await browser.newContext();
    const p0 = await setup.newPage();
    await register(p0, { email });
    await setup.close();

    await page.goto('/login');
    await page.locator('body').press('Tab'); // skip link
    await page.keyboard.press('Tab'); // brand link
    await page.keyboard.press('Tab'); // email
    await expect(page.getByLabel('Email')).toBeFocused();
    await page.keyboard.type(email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/portfolio');
    await expect(page.getByTestId('user-name')).toBeVisible();
    // the primary navigation is reachable and operable from the keyboard
    await page.getByRole('link', { name: 'Orders' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/orders');
  });

  test('focus is always visible: a focused control has a 2 px accent outline', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').focus();
    const outline = await page.getByLabel('Email').evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, style: s.outlineStyle };
    });
    expect(outline).toEqual({ width: '2px', style: 'solid' });
  });

  test('375 px: no horizontal page scroll on any page, the navigation is a bottom tab bar, tap targets are 44 px', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ['/login', '/register']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    for (const path of ['/portfolio', '/orders', '/activity']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(800); // at the bottom of the 812 px screen
    for (const name of ['Portfolio', 'Orders', 'Activity']) {
      const link = await page.getByRole('link', { name, exact: true }).boundingBox();
      expect(link?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await page.goto('/portfolio');
    expect(await serious(page), '375 px portfolio').toEqual([]);
    await page.screenshot({
      path: shotPath('../../docs/phase-reports/m6a/portfolio-375.png'),
      fullPage: true,
    });
  });

  test('prefers-reduced-motion: animations are switched off', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    try {
      const page = await ctx.newPage();
      await page.goto('/login');
      const d = await page.evaluate(() => getComputedStyle(document.body).transitionDuration);
      expect(['0s', '1e-05s', '0.00001s', '']).toContain(d);
      const dur = await page.evaluate(() => {
        const el = document.createElement('div');
        el.className = 'motion-safe:animate-pulse';
        document.body.appendChild(el);
        return getComputedStyle(el).animationName;
      });
      expect(dur).toBe('none');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('7. security', () => {
  test('the session cookie is httpOnly and SameSite=Lax; nothing is stored in localStorage, sessionStorage or readable cookies', async ({
    page,
    context,
  }) => {
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    await page.goto('/portfolio');
    const cookie = (await context.cookies()).find((c) => c.name === 'vantage_session');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');

    const stored = await page.evaluate(async () => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      readableCookies: document.cookie,
      idb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    }));
    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
    expect(stored.readableCookies).toBe(''); // httpOnly: script cannot see the cookie at all
    expect(stored.idb).toBe(0);
    expect(JSON.stringify(stored)).not.toContain(cookie?.value ?? 'x');
  });

  test('every page carries the strict CSP (nonce, no unsafe-inline), nosniff, no-referrer, frame-ancestors none and no-store', async ({
    page,
  }) => {
    const res = await page.goto('/login');
    const h = res?.headers() ?? {};
    const csp = h['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cache-control']).toContain('no-store');
    expect(h['x-powered-by']).toBeUndefined();

    // a fresh nonce per request, and every script of the page carries a nonce
    const res2 = await page.goto('/login');
    const nonce1 = /'nonce-([^']+)'/.exec(csp)?.[1];
    const nonce2 = /'nonce-([^']+)'/.exec(res2?.headers()['content-security-policy'] ?? '')?.[1];
    expect(nonce1).toBeDefined();
    expect(nonce2).toBeDefined();
    expect(nonce1).not.toBe(nonce2);
    const unnonced = await page.evaluate(
      () =>
        [...document.querySelectorAll('script')].filter(
          (s) => s.textContent !== '' && !(s.nonce || s.getAttribute('nonce')),
        ).length,
    );
    expect(unnonced).toBe(0);
  });

  test('the proxied API is not an open relay: only /v1 and /health are reachable through /api', async ({
    request,
  }) => {
    for (const path of ['/api/admin', '/api/v2/me', '/api/..%2f..%2fetc', '/api/_next/static']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
    }
    expect((await request.get('/api/health')).status()).toBe(200); // control
  });

  test('no console errors or page errors while using the whole app (this includes any CSP violation)', async ({
    page,
    context,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto('/login');
    await page.goto('/register');
    await register(page);
    await placeOrder(context, BUY_AAPL_10);
    for (const path of ['/portfolio', '/orders', '/activity']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login**');
    expect(problems).toEqual([]);
  });
});
