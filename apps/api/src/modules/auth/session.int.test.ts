import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD_HASHER } from '../../tokens.js';
import {
  VALID_PASSWORD,
  WEB_ORIGIN,
  createHarness,
  registerBody,
  sessionTokenFrom,
} from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import { argon2Hasher } from './password.hasher.js';

let db: TestDatabase;
let h: Harness;
/** Every hash passed to verify(), in order: proves the verifier runs for unknown emails too. */
const verifyCalls: string[] = [];
const spyHasher = {
  hash: argon2Hasher.hash,
  verify: (encoded: string, password: string) => {
    verifyCalls.push(encoded);
    return argon2Hasher.verify(encoded, password);
  },
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db, {
    env: { SESSION_IDLE_MINUTES: '30', SESSION_ABSOLUTE_DAYS: '7' },
    overrides: [[PASSWORD_HASHER, spyHasher]],
  });
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const post = (path: string, body: unknown, origin: string | null = WEB_ORIGIN) => {
  const r = h.http.post(path).send(body as object);
  return origin === null ? r : r.set('Origin', origin);
};
const login = (email: string, password = VALID_PASSWORD) =>
  post('/v1/auth/login', { email, password });
const me = (token: string | undefined) =>
  token === undefined
    ? h.http.get('/v1/me')
    : h.http.get('/v1/me').set('Cookie', `vantage_session=${token}`);

async function registerUser(email: string): Promise<string> {
  const res = await post('/v1/auth/register', registerBody(email));
  expect(res.status).toBe(201);
  const token = sessionTokenFrom(res.headers['set-cookie']);
  expect(token).toBeDefined();
  return token ?? '';
}

describe('4. login and sessions', () => {
  it('a successful login creates a NEW session and token (control for the failures below)', async () => {
    const registered = await registerUser('login1@example.com');
    const res = await login('login1@example.com');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('login1@example.com');
    const token = sessionTokenFrom(res.headers['set-cookie']);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(registered); // never reuse a token
    expect((await me(token)).status).toBe(200);
    const n = await db.migrator.query<{ n: string; ip: string | null }>(
      `SELECT count(*) AS n, max(host(ip)) AS ip FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'login1@example.com'`,
    );
    expect(n.rows[0]?.n).toBe('2'); // the registration session and the login session
    expect(n.rows[0]?.ip).not.toBeNull(); // ip stored
  });

  it('wrong password and unknown email are indistinguishable, and both run the verifier', async () => {
    await registerUser('login2@example.com');
    const base = verifyCalls.length;
    const wrongPw = await login('login2@example.com', 'definitely not the password');
    expect(verifyCalls.length).toBe(base + 1);
    const unknown = await login('nobody@example.com');
    expect(verifyCalls.length).toBe(base + 2);

    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body.error.code).toBe('INVALID_CREDENTIALS');
    expect({ code: unknown.body.error.code, message: unknown.body.error.message }).toEqual({
      code: wrongPw.body.error.code,
      message: wrongPw.body.error.message,
    });
    expect(wrongPw.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();

    // the unknown-email path verified a real Argon2id dummy hash, not the user's hash
    const userHash = (
      await db.migrator.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE email = 'login2@example.com'`,
      )
    ).rows[0]?.password_hash;
    expect(verifyCalls[base]).toBe(userHash);
    expect(verifyCalls[base + 1]).not.toBe(userHash);
    expect(verifyCalls[base + 1]?.startsWith('$argon2id$')).toBe(true);
  });

  it('a tampered, garbage or missing cookie gets 401 in the envelope (control: the real one works)', async () => {
    const token = await registerUser('tamper@example.com');
    expect((await me(token)).status).toBe(200);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [flipped, 'garbage', `${token}x`, token.slice(1), 'A'.repeat(43)]) {
      const res = await me(bad);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect((await me(undefined)).status).toBe(401);
  });

  it('an absolute-expired session is rejected (advance the injected clock past 7 days)', async () => {
    // idle window set to its maximum (7 days) so only the absolute limit can end this session
    const ha = await createHarness(db, {
      env: { SESSION_IDLE_MINUTES: '10080', SESSION_ABSOLUTE_DAYS: '7' },
    });
    try {
      const reg = await ha.http
        .post('/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registerBody('abs@example.com'));
      const token = sessionTokenFrom(reg.headers['set-cookie']) ?? '';
      const meA = () => ha.http.get('/v1/me').set('Cookie', `vantage_session=${token}`);
      ha.clock.advance(6 * DAY);
      expect((await meA()).status).toBe(200); // control: still inside both limits
      ha.clock.advance(DAY + MINUTE); // 7 days and a minute since creation, but active the day before
      expect((await meA()).status).toBe(401);
    } finally {
      await ha.close();
    }
  });

  it('an idle session is rejected, and activity slides the idle window (control)', async () => {
    const token = await registerUser('idle@example.com');
    h.clock.advance(20 * MINUTE);
    expect((await me(token)).status).toBe(200); // touches last_seen_at
    h.clock.advance(20 * MINUTE); // 40 min since creation but only 20 since the last use
    expect((await me(token)).status).toBe(200);
    h.clock.advance(31 * MINUTE); // idle for 31 minutes > 30
    expect((await me(token)).status).toBe(401);
  });

  it('last_seen_at is updated at most once a minute', async () => {
    const token = await registerUser('touch@example.com');
    const seen = async () =>
      (
        await db.migrator.query<{ t: Date }>(
          `SELECT max(last_seen_at) AS t FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'touch@example.com'`,
        )
      ).rows[0]?.t.getTime();
    const t0 = await seen();
    h.clock.advance(30_000);
    await me(token);
    expect(await seen()).toBe(t0); // inside the minute: not written
    h.clock.advance(31_000);
    await me(token);
    expect(await seen()).toBe((t0 ?? 0) + 61_000);
  });

  it('logout revokes the session and clears the cookie; the same cookie then fails (control: it worked before)', async () => {
    const token = await registerUser('logout@example.com');
    expect((await me(token)).status).toBe(200);
    const out = await h.http
      .post('/v1/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', `vantage_session=${token}`);
    expect(out.status).toBe(204);
    const cleared = (out.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cleared).toContain('vantage_session=;');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect((await me(token)).status).toBe(401);
    const row = await db.migrator.query<{ revoked_at: Date | null }>(
      `SELECT s.revoked_at FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'logout@example.com'`,
    );
    expect(row.rows[0]?.revoked_at).not.toBeNull();
  });

  it('logout without a session still returns 204 and clears the cookie', async () => {
    const out = await post('/v1/auth/logout', {});
    expect(out.status).toBe(204);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
  });
});

describe('5. CSRF origin rule', () => {
  it('a wrong or missing Origin gets 403 on every state-changing route; the right one works', async () => {
    await registerUser('csrf@example.com');
    const routes: Array<[string, unknown]> = [
      ['/v1/auth/login', { email: 'csrf@example.com', password: VALID_PASSWORD }],
      ['/v1/auth/register', registerBody('csrf2@example.com')],
      ['/v1/auth/logout', {}],
    ];
    for (const [path, body] of routes) {
      for (const origin of ['http://evil.example', 'http://localhost:3001', 'null', null]) {
        const res = await post(path, body, origin);
        expect(res.status, `${path} with Origin ${String(origin)}`).toBe(403);
        expect(res.body.error.code).toBe('CSRF_REJECTED');
      }
    }
    expect((await post('/v1/auth/login', routes[0]?.[1])).status).toBe(200); // control
    expect((await post('/v1/auth/logout', {})).status).toBe(204); // control
  });

  it('with no Origin, the Referer decides (control: the right one passes; a wrong one is refused)', async () => {
    const body = { email: 'csrf@example.com', password: VALID_PASSWORD };
    const ok = await h.http
      .post('/v1/auth/login')
      .set('Referer', `${WEB_ORIGIN}/some/page`)
      .send(body);
    expect(ok.status).toBe(200);
    const bad = await h.http
      .post('/v1/auth/login')
      .set('Referer', 'http://evil.example/page')
      .send(body);
    expect(bad.status).toBe(403);
    const junk = await h.http.post('/v1/auth/login').set('Referer', 'not a url').send(body);
    expect(junk.status).toBe(403);
  });

  it('GET requests need no Origin (control), and CORS allows only WEB_ORIGIN with credentials', async () => {
    expect((await h.http.get('/health')).status).toBe(200);
    const allowed = await h.http
      .options('/v1/me')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await h.http
      .options('/v1/me')
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(denied.headers['access-control-allow-origin']).not.toBe('http://evil.example');
  });
});

describe('6. rate limiting', () => {
  it('the 6th failed login for one (IP, email) gets 429 with Retry-After; another email is unaffected', async () => {
    await registerUser('rl-a@example.com');
    await registerUser('rl-b@example.com');
    for (let i = 1; i <= 5; i += 1) {
      const res = await login('rl-a@example.com', `wrong password ${String(i)}`);
      expect(res.status, `attempt ${String(i)}`).toBe(401);
    }
    const blocked = await login('rl-a@example.com', 'wrong password 6');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    const retry = Number(blocked.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(900);
    // even the right password is refused while blocked
    expect((await login('rl-a@example.com')).status).toBe(429);
    // a different email from the same IP is unaffected (control)
    expect((await login('rl-b@example.com', 'wrong')).status).toBe(401);
    expect((await login('rl-b@example.com')).status).toBe(200);
  });

  it('the window slides: after 15 minutes the pair may try again', async () => {
    h.clock.advance(15 * MINUTE + 1000);
    expect((await login('rl-a@example.com')).status).toBe(200);
  });

  it('the per-IP limit of 20 failures applies to fresh emails, then lifts after the window', async () => {
    h.clock.advance(15 * MINUTE + 1000); // start from a clean slate for the IP counter
    for (let i = 0; i < 20; i += 1) {
      const res = await login(`ip-limit-${String(i)}@example.com`, 'wrong');
      expect(res.status, `failure ${String(i + 1)}`).toBe(401);
    }
    const blocked = await login('ip-limit-fresh@example.com', 'wrong');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    h.clock.advance(15 * MINUTE + 1000);
    expect((await login('ip-limit-fresh@example.com', 'wrong')).status).toBe(401); // control: allowed again
  });

  it('registrations are limited to 10 per hour per IP (11th gets 429), tested on a fresh app', async () => {
    const hr = await createHarness(db);
    try {
      for (let i = 0; i < 10; i += 1) {
        const r = await hr.http
          .post('/v1/auth/register')
          .set('Origin', WEB_ORIGIN)
          .send(registerBody(`reg-limit-${String(i)}@example.com`));
        expect(r.status, `registration ${String(i + 1)}`).toBe(201);
      }
      const blocked = await hr.http
        .post('/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registerBody('reg-limit-11@example.com'));
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      hr.clock.advance(60 * MINUTE + 1000);
      const again = await hr.http
        .post('/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registerBody('reg-limit-11@example.com'));
      expect(again.status).toBe(201);
    } finally {
      await hr.close();
    }
  });
});
