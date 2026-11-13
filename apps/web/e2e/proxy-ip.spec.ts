// D-69 through the REAL web proxy: the web server is the API's one trusted proxy, so an X-Forwarded-For sent to the web
// app reaches the API as the client address, and login limits are per client, not shared by everyone behind the proxy.
import { expect, test } from '@playwright/test';
import { PASSWORD, WEB_ORIGIN, uniqueEmail } from './helpers';

const headers = (ip: string) => ({
  Origin: WEB_ORIGIN,
  'X-Forwarded-For': ip,
  'Content-Type': 'application/json',
});

test('two clients behind the proxy do not share login limits: locking one out leaves the other signing in', async ({
  request,
}) => {
  const email = uniqueEmail('proxy');
  const reg = await request.post('/api/v1/auth/register', {
    headers: headers('198.51.100.1'),
    data: {
      email,
      password: PASSWORD,
      displayName: 'Proxy Test',
      countryCode: 'IN',
      confirmAdult: true,
      acceptTerms: true,
    },
  });
  expect(reg.status()).toBe(201);

  for (let i = 0; i < 5; i += 1) {
    const bad = await request.post('/api/v1/auth/login', {
      headers: headers('198.51.100.1'),
      data: { email, password: 'wrong password' },
    });
    expect(bad.status()).toBe(401);
  }
  const locked = await request.post('/api/v1/auth/login', {
    headers: headers('198.51.100.1'),
    data: { email, password: PASSWORD },
  });
  expect(locked.status()).toBe(429);
  expect(Number(locked.headers()['retry-after'])).toBeGreaterThan(0);

  // client 2 behind the same proxy, same email: not locked (control)
  const other = await request.post('/api/v1/auth/login', {
    headers: headers('198.51.100.2'),
    data: { email, password: PASSWORD },
  });
  expect(other.status()).toBe(200);
});

test('a client-supplied entry on the left of X-Forwarded-For cannot choose the identity', async ({
  request,
}) => {
  const email = uniqueEmail('left');
  await request.post('/api/v1/auth/register', {
    headers: headers('198.51.100.5'),
    data: {
      email,
      password: PASSWORD,
      displayName: 'Left Test',
      countryCode: 'IN',
      confirmAdult: true,
      acceptTerms: true,
    },
  });
  // the real client is the LAST entry (what a front proxy appends); the leftmost values are made up each time
  for (let i = 0; i < 5; i += 1) {
    await request.post('/api/v1/auth/login', {
      headers: headers(`203.0.113.${String(i + 1)}, 198.51.100.50`),
      data: { email, password: 'wrong password' },
    });
  }
  const locked = await request.post('/api/v1/auth/login', {
    headers: headers('203.0.113.99, 198.51.100.50'),
    data: { email, password: PASSWORD },
  });
  expect(locked.status()).toBe(429);
  const fresh = await request.post('/api/v1/auth/login', {
    headers: headers('198.51.100.51'),
    data: { email, password: PASSWORD },
  });
  expect(fresh.status()).toBe(200);
});

test('the browser login form still works through the proxy (no header is needed in normal use)', async ({
  page,
}) => {
  const email = uniqueEmail('form');
  await page.goto('/register');
  const res = await page.request.post('/api/v1/auth/register', {
    headers: { Origin: WEB_ORIGIN },
    data: {
      email,
      password: PASSWORD,
      displayName: 'Form Test',
      countryCode: 'IN',
      confirmAdult: true,
      acceptTerms: true,
    },
  });
  expect(res.status()).toBe(201);
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/portfolio');
});
