import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { API_PORT, CONTROL_PORT, WEB_PORT } from '../playwright.config';

export const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`;
export const API_ORIGIN = `http://localhost:${String(API_PORT)}`;
export const PASSWORD = 'correct horse battery';

export const uniqueEmail = (label = 'e2e'): string =>
  `${label}-${randomUUID().slice(0, 8)}@example.com`;

/** Talks to the test-only control server of the API launcher (quotes and the injected clock). */
export async function control(path: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${String(CONTROL_PORT)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${path} failed with ${String(res.status)}`);
}

export const setQuote = (
  symbol: string,
  bid: string,
  ask: string,
  extra: object = {},
): Promise<void> => control('/quote', { symbol, bid, ask, ...extra });
export const clearQuote = (symbol: string): Promise<void> =>
  control('/quote', { symbol, clear: true });

/** Fills and submits the registration form (does not wait for the result). */
export async function submitRegistration(
  page: Page,
  opts: { email?: string; password?: string; displayName?: string } = {},
): Promise<{ email: string; password: string }> {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? PASSWORD;
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Display name').fill(opts.displayName ?? 'E2E Tester');
  await page.getByLabel('Country').selectOption('IN');
  await page.getByLabel('I confirm that I am an adult.').check();
  await page
    .getByLabel('I accept the terms and understand this is virtual money, not real trading.')
    .check();
  await page.getByRole('button', { name: 'Create account' }).click();
  return { email, password };
}

/** Registers through the real form and waits for the portfolio page. */
export async function register(
  page: Page,
  opts: { email?: string; password?: string; displayName?: string } = {},
): Promise<{ email: string; password: string }> {
  const r = await submitRegistration(page, opts);
  await page.waitForURL('**/portfolio');
  return r;
}

export async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/portfolio');
}

/**
 * Places an order through the API directly (the M4b endpoint), as the signed-in user of this browser context: the
 * context's cookie jar carries the session, and the Origin header is the one the API accepts.
 */
export async function placeOrder(
  context: BrowserContext,
  body: Record<string, unknown>,
  key = `e2e-${randomUUID()}`,
): Promise<Record<string, unknown>> {
  const res = await context.request.post(`${API_ORIGIN}/v1/orders`, {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': key, 'Content-Type': 'application/json' },
    data: body,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

export const BUY_AAPL_10 = {
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  qty: '10',
  referencePrice: '190.00',
};
