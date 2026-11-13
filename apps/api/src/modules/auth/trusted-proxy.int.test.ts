// D-69 over real HTTP and real Postgres: X-Forwarded-For is believed only from a configured trusted proxy. Every test
// has a control that shows the same request behaving differently once the sender IS trusted (or the reverse).
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN, VALID_PASSWORD, createHarness, registerBody } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';

// the test client connects from the loopback address, so that is "the proxy" in the trusted harness
const TRUSTED = '127.0.0.1/32,::1/128';

let db: TestDatabase;
let open: Harness; // trusts nobody (the default)
let behind: Harness; // trusts the loopback proxy
beforeAll(async () => {
  db = await createTestDatabase();
  open = await createHarness(db);
  behind = await createHarness(db, { env: { TRUSTED_PROXY_CIDRS: TRUSTED } });
});
afterAll(async () => {
  await open.close();
  await behind.close();
  await db.dispose();
});

let n = 0;
const email = (label: string): string =>
  `${label}${String((n += 1))}-${Math.random().toString(16).slice(2, 8)}@example.com`;

const register = (h: Harness, addr: string, e: string) =>
  h.http
    .post('/v1/auth/register')
    .set('Origin', WEB_ORIGIN)
    .set('X-Forwarded-For', addr)
    .send(registerBody(e));
const login = (h: Harness, addr: string | undefined, e: string, password = VALID_PASSWORD) => {
  let req = h.http.post('/v1/auth/login').set('Origin', WEB_ORIGIN);
  if (addr !== undefined) req = req.set('X-Forwarded-For', addr);
  return req.send({ email: e, password });
};
const fail = async (h: Harness, addr: string, e: string, times: number) => {
  for (let i = 0; i < times; i += 1) await login(h, addr, e, 'definitely wrong password');
};

describe('login limits are per client address, and the address is believed only from a trusted proxy', () => {
  it('behind a trusted proxy two clients do not share a login limit: locking one out leaves the other untouched', async () => {
    const e = email('pair');
    await register(behind, '198.51.100.1', e);
    await fail(behind, '198.51.100.1', e, 5); // client 1: five failures for this email
    const locked = await login(behind, '198.51.100.1', e);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    // client 2, same email, same proxy: not locked (control), and can sign in
    const other = await login(behind, '198.51.100.2', e);
    expect(other.status).toBe(200);
    // client 1 is still locked even with the right password
    expect((await login(behind, '198.51.100.1', e)).status).toBe(429);
  });

  it('the per-address limit (20 failures from one client) locks that client only', async () => {
    const a = email('ipa');
    const b = email('ipb');
    await register(behind, '198.51.100.10', a);
    await register(behind, '198.51.100.11', b);
    for (let i = 0; i < 20; i += 1)
      await login(behind, '198.51.100.10', email('nobody'), 'wrong password');
    expect((await login(behind, '198.51.100.10', a)).status).toBe(429); // client 10 is locked for every email
    expect((await login(behind, '198.51.100.11', b)).status).toBe(200); // client 11 is unaffected
  }, 120_000);

  it('MUST FAIL: a spoofed X-Forwarded-For from a source that is not a trusted proxy is ignored, so changing it does not escape a lockout', async () => {
    const e = email('spoof');
    await register(open, '198.51.100.20', e);
    await fail(open, '198.51.100.20', e, 5);
    // the attacker now "becomes" another address by changing the header: the limit still applies
    for (const addr of ['198.51.100.21', '203.0.113.99', '1.1.1.1', '127.0.0.1, 10.0.0.1']) {
      expect((await login(open, addr, e)).status, addr).toBe(429);
    }
    // and with no header at all the same client is still locked
    expect((await login(open, undefined, e)).status).toBe(429);
  });

  it('control: the identical sequence behind a trusted proxy treats the changed header as a different client', async () => {
    const e = email('ctrl');
    await register(behind, '198.51.100.30', e);
    await fail(behind, '198.51.100.30', e, 5);
    expect((await login(behind, '198.51.100.30', e)).status).toBe(429);
    expect((await login(behind, '198.51.100.31', e)).status).toBe(200);
  });

  it('a client-supplied entry on the left cannot choose the identity behind the proxy (the proxy-appended one on the right wins)', async () => {
    const e = email('left');
    await register(behind, '198.51.100.40', e);
    // the client claims to be a fresh address in front of the real one each time; the real address is the last entry
    for (let i = 0; i < 5; i += 1)
      await login(behind, `203.0.113.${String(i + 1)}, 198.51.100.40`, e, 'wrong password');
    expect((await login(behind, '203.0.113.200, 198.51.100.40', e)).status).toBe(429);
    expect((await login(behind, '198.51.100.41', e)).status).toBe(200); // a different real client is fine
  });

  it('a malformed header falls back to the proxy address (never a guess), and cannot crash anything', async () => {
    for (const bad of [
      'garbage',
      '<script>alert(1)</script>',
      ',,,',
      'a'.repeat(5000),
      '999.1.1.1',
    ]) {
      const res = await login(behind, bad, email('bad'));
      expect([401, 429], bad.slice(0, 20)).toContain(res.status); // an ordinary answer, not a 500
    }
  });
});

describe('registration limit (10 per hour per address) and the audit trail use the resolved address', () => {
  // fresh apps (and so fresh in-memory limiters): the tests above already used some of the registration allowance
  let open: Harness;
  let behind: Harness;
  beforeAll(async () => {
    open = await createHarness(db);
    behind = await createHarness(db, { env: { TRUSTED_PROXY_CIDRS: TRUSTED } });
  });
  afterAll(async () => {
    await open.close();
    await behind.close();
  });

  it('behind a trusted proxy 12 clients can each register once; without trust the 11th registration from "one" address is limited (control)', async () => {
    const t = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        register(behind, `198.51.101.${String(i + 1)}`, email('reg')),
      ),
    );
    expect(t.map((r) => r.status)).toEqual(Array(12).fill(201));

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1)
      statuses.push((await register(open, `198.51.102.${String(i + 1)}`, email('reg'))).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses.slice(10)).toEqual([429, 429]); // all twelve were one client to the API: the spoofed headers did not help
  }, 120_000);

  it('the audit row of a login records the resolved client address (trusted) or the socket address (untrusted)', async () => {
    const e1 = email('audit');
    const e2 = email('audit');
    // own apps again: the registration test above used up this block's registration allowance
    const trusted = await createHarness(db, { env: { TRUSTED_PROXY_CIDRS: TRUSTED } });
    const untrusted = await createHarness(db);
    try {
      await register(trusted, '198.51.100.50', e1);
      await register(untrusted, '198.51.100.51', e2);
      expect((await login(trusted, '198.51.100.50', e1)).status).toBe(200);
      expect((await login(untrusted, '198.51.100.51', e2)).status).toBe(200);
    } finally {
      await trusted.close();
      await untrusted.close();
    }
    const rows = await db.migrator.query(
      `SELECT host(ip) AS ip FROM audit_logs WHERE action = 'LOGIN_SUCCEEDED' ORDER BY id DESC LIMIT 2`,
    );
    const ips = rows.rows.map((r) => r.ip as string);
    expect(ips).toContain('198.51.100.50'); // believed from the trusted proxy
    expect(ips).not.toContain('198.51.100.51'); // spoofed to an open API: ignored
    expect(ips.some((x) => x === '127.0.0.1' || x === '::1')).toBe(true); // the socket address was recorded instead
  });
});
