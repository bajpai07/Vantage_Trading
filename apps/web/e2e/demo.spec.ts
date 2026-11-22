// M10 (D-112, D-113): the public /about page and the guarded "Try the demo" button. This profile runs with DEMO_ACCOUNTS=on; the control
// (the flag off: no button anywhere) is in always-open.spec.ts, whose profile runs with DEMO_ACCOUNTS=off.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { control, register, setQuote } from './helpers';

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

for (const [label, size] of [
  ['1440', { width: 1440, height: 900 }],
  ['390', { width: 390, height: 844 }],
] as const) {
  test.describe(`/about at ${label} px`, () => {
    test.use({ viewport: size });

    test('renders without signing in, is axe clean, has no horizontal scroll and no console or CSP errors', async ({
      page,
    }) => {
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) =>
          console.error(`CSP violation: ${e.violatedDirective}`),
        );
      });
      const res = await page.goto('/about');
      expect(res?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe('/about'); // not redirected to the login page
      await expect(page.getByTestId('about-page')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('How VANTAGE works');
      await expect(page.getByTestId('about-page')).toContainText('QBX-1');
      await expect(page.getByTestId('about-page')).toContainText('not a brokerage');
      expect(await serious(page)).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(problems).toEqual([]);
    });

    test('its links work', async ({ page }) => {
      await page.goto('/about');
      await page
        .getByTestId('about-page')
        .getByRole('link', { name: 'Third-party notices' })
        .click();
      await page.waitForURL('**/third-party-notices');
      await expect(page.getByTestId('notices-page')).toBeVisible();
      await page.goto('/about');
      await page.getByTestId('about-page').getByRole('link', { name: 'Sign in' }).click();
      await page.waitForURL('**/login');
    });
  });
}

test('the footer links to /about from the login page', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('about-link').click();
  await page.waitForURL('**/about');
  await expect(page.getByTestId('about-page')).toBeVisible();
});

test.describe('the demo button (flag on)', () => {
  test('is present on the login and the register page', async ({ page }) => {
    for (const path of ['/login', '/register']) {
      await page.goto(path);
      await expect(page.getByTestId('demo-button'), path).toBeVisible();
      expect(await serious(page), path).toEqual([]);
    }
  });

  test('one click creates a fresh account: portfolio with $10,000.00 from the server, the notice, no stored data, no password anywhere', async ({
    page,
  }) => {
    const consoleText: string[] = [];
    const urls: string[] = [];
    const responseBodies: string[] = [];
    let password = '';
    let email = '';
    page.on('console', (m) => consoleText.push(m.text()));
    page.on('request', (req) => {
      urls.push(req.url());
      if (req.url().endsWith('/api/v1/auth/register') && req.method() === 'POST') {
        const body = JSON.parse(req.postData() ?? '{}') as { password?: string; email?: string };
        password = body.password ?? '';
        email = body.email ?? '';
      }
    });
    page.on('response', (res) => {
      if (res.url().includes('/api/')) {
        void res.text().then(
          (t) => responseBodies.push(t),
          () => undefined,
        );
      }
    });
    await page.goto('/login');
    await page.getByTestId('demo-button').click();
    await page.waitForURL('**/portfolio');
    await expect(page.getByTestId('metric-equity')).toContainText('10,000.00');
    await expect(page.getByTestId('demo-notice')).toContainText('temporary demo account');

    // a generated address on the reserved domain and a long random password, used once
    expect(email).toMatch(/^demo-[0-9a-f]{20}@demo\.invalid$/);
    expect(password.length).toBeGreaterThanOrEqual(30);

    // the password appears in no page text, URL, console line or response, and nothing is stored in the browser
    await page.goto('/portfolio');
    expect(await page.content()).not.toContain(password);
    expect(page.url()).not.toContain(password);
    expect(
      urls.filter((u) => u.includes(password) || u.includes(encodeURIComponent(password))),
    ).toEqual([]);
    expect(consoleText.filter((t) => t.includes(password))).toEqual([]);
    expect(responseBodies.filter((t) => t.includes(password))).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      cookie: document.cookie,
    }));
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
    expect(stored.cookie).toBe('');
  });

  test('two clicks make two different accounts', async ({ browser }) => {
    const emails: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('request', (req) => {
        if (req.url().endsWith('/api/v1/auth/register') && req.method() === 'POST') {
          emails.push((JSON.parse(req.postData() ?? '{}') as { email: string }).email);
        }
      });
      await page.goto('/register');
      await page.getByTestId('demo-button').click();
      await page.waitForURL('**/portfolio');
      await context.close();
    }
    expect(emails).toHaveLength(2);
    expect(new Set(emails).size).toBe(2);
  });

  test('a normal (non-demo) account does not see the temporary-account notice (control)', async ({
    page,
  }) => {
    await register(page);
    await expect(page.getByTestId('demo-notice')).toHaveCount(0);
  });

  test('a rate-limited registration shows the usual friendly message and no account is created', async ({
    page,
  }) => {
    await page.route('**/api/v1/auth/register', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'retry-after': '120', 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'RATE_LIMITED' }),
      }),
    );
    await page.goto('/login');
    await page.getByTestId('demo-button').click();
    await expect(page.getByTestId('demo-problem')).toContainText(
      'Too many attempts. Please wait 2 minutes and try again.',
    );
    expect(new URL(page.url()).pathname).toBe('/login');
    await expect(page.getByTestId('demo-button')).toBeEnabled();
  });
});
