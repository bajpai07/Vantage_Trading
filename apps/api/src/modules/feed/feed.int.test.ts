// GET /v1/market/feed is public and reports the active data source (the web app's "Simulated market data" banner
// is driven by it). Real Postgres and a real HTTP request; no session.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import { FeedInfoService } from './feed.module.js';

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db);
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

describe('GET /v1/market/feed', () => {
  it('needs no session and reports the FIXTURE source, the delayed entitlement and the delay', async () => {
    const res = await h.http.get('/v1/market/feed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: 'FIXTURE',
      entitlement: 'DELAYED',
      delaySeconds: 900,
      enabled: true,
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports the kill switch (control: it comes back on)', async () => {
    const feed = h.app.get(FeedInfoService);
    feed.setEnabled(false);
    try {
      expect((await h.http.get('/v1/market/feed')).body).toMatchObject({
        source: 'FIXTURE',
        enabled: false,
      });
    } finally {
      feed.setEnabled(true);
    }
    expect((await h.http.get('/v1/market/feed')).body).toMatchObject({ enabled: true });
  });

  it('is read-only and carries nothing about users (control: other verbs are not routed)', async () => {
    expect(
      (await h.http.post('/v1/market/feed').set('Origin', 'http://localhost:3000')).status,
    ).toBe(404);
    expect(JSON.stringify((await h.http.get('/v1/market/feed')).body)).not.toMatch(
      /user|email|account/i,
    );
  });
});
