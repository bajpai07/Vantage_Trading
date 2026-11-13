import { expect, test } from '@playwright/test';
import { login, register, submitRegistration, uniqueEmail } from './helpers';

test.describe('register, login, logout and server-side route protection', () => {
  test('protected pages redirect to /login before anything private is rendered; /login is open (control)', async ({
    page,
  }) => {
    for (const path of ['/portfolio', '/orders', '/activity', '/']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    }
  });

  test('register lands on the portfolio; sign out returns to /login; the session is really gone', async ({
    page,
    context,
  }) => {
    const { email } = await register(page, { displayName: 'Ada Lovelace' });
    await expect(page.getByTestId('user-name')).toHaveText('Ada Lovelace');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login**');
    await expect(page.getByTestId('notice')).toContainText('You have been signed out.');
    expect(
      (await context.cookies()).some((c) => c.name === 'vantage_session' && c.value !== ''),
    ).toBe(false);

    await page.goto('/portfolio');
    await expect(page).toHaveURL(/\/login$/);

    // control: the same account signs back in
    await login(page, email);
    await expect(page.getByTestId('user-name')).toBeVisible();
  });

  test('a signed-in user visiting /login or /register is sent to the portfolio', async ({
    page,
  }) => {
    await register(page);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/portfolio$/);
    await page.goto('/register');
    await expect(page).toHaveURL(/\/portfolio$/);
  });

  test('wrong password: one plain sentence (no raw JSON), the support code is the only internal detail; no password in the URL', async ({
    page,
  }) => {
    const { email } = await register(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login**');

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('definitely the wrong one');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const alert = page.getByTestId('error-message');
    await expect(alert).toContainText('Wrong email or password.');
    await expect(alert).toContainText('Support code:');
    await expect(alert).not.toContainText(/INVALID_CREDENTIALS|\{|error"/);
    await expect(page).toHaveURL(/\/login(\?.*)?$/);
    expect(page.url()).not.toContain('wrong');
  });

  test('registration shows inline errors per field, ties them to the inputs, and disables nothing it should not', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#email-error')).toContainText('Enter a valid email address.');
    await expect(page.locator('#password-error')).toContainText('10 to 128 characters');
    await expect(page.locator('#countryCode-error')).toContainText('Choose your country.');
    await expect(page.locator('#confirmAdult-error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('registering an email that already exists says so plainly and stays on the form', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('dup');
    await register(page, { email });
    const other = await browser.newContext();
    try {
      const p2 = await other.newPage();
      await submitRegistration(p2, { email });
      await expect(p2.getByTestId('error-message')).toContainText('already exists');
      await expect(p2.locator('#email-error')).toContainText('already registered');
      await expect(p2).toHaveURL(/\/register$/);
    } finally {
      await other.close();
    }
  });
});
