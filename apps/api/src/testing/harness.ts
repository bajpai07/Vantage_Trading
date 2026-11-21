// Test harness: a real Nest app against a real test database, as vantage_app, with an injectable clock,
// captured logs and optional provider overrides. Not part of the build (see tsconfig.build.json).
import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Module } from '@nestjs/common';
import type { ModuleDefinition } from '@nestjs/core/interfaces/module-definition.interface.js';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { loadConfig } from '@vantage/config';
import type { Config } from '@vantage/config';
import { buildTestEnv } from '@vantage/config/testing';
import type { TestDatabase } from '@vantage/test-utils';
import { AppModule } from '../app.module.js';
import { configureApp } from '../configure-app.js';
import { createLogger } from '../log.js';
import { CLOCK, CONFIG, LOGGER } from '../tokens.js';
import type { Clock } from '../tokens.js';

export const WEB_ORIGIN = 'http://localhost:3000';

export interface Harness {
  readonly app: NestExpressApplication;
  readonly http: ReturnType<typeof supertest>;
  readonly config: Config;
  /** Captured log lines (JSON strings). */
  readonly logs: string[];
  readonly clock: { now(): Date; advance(ms: number): void; set(iso: string): void };
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Initial value of the injected clock (ISO). Default 2026-11-10T12:00:00Z. */
  readonly now?: string;
  readonly env?: Record<string, string | undefined>;
  /** token -> replacement value (useValue). */
  readonly overrides?: ReadonlyArray<readonly [unknown, unknown]>;
  /** Modules replaced by an empty one (for a test that proves a module has no effect on the rest). */
  readonly withoutModules?: readonly ModuleDefinition[];
}

@Module({})
class EmptyModule {}

export async function createHarness(db: TestDatabase, opts: HarnessOptions = {}): Promise<Harness> {
  const config = loadConfig(
    buildTestEnv({
      APP_ENV: 'test',
      DATABASE_URL: db.appUrl,
      WEB_ORIGIN,
      COOKIE_SECURE: 'false',
      ...opts.env,
    }),
  );
  const logs: string[] = [];
  const logger = createLogger('debug', (line) => logs.push(line));
  let t = Date.parse(opts.now ?? '2026-11-10T12:00:00.000Z');
  const clock: Clock & { advance(ms: number): void; set(iso: string): void } = {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
    set: (iso) => {
      t = Date.parse(iso);
    },
  };

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(LOGGER)
    .useValue(logger);
  for (const m of opts.withoutModules ?? [])
    builder = builder.overrideModule(m).useModule(EmptyModule);
  for (const [token, value] of opts.overrides ?? []) {
    builder = builder.overrideProvider(token as never).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, config, logger);
  try {
    await app.init();
  } catch (e) {
    await app.close().catch(() => undefined); // do not leak the pool when startup is refused
    throw e;
  }

  return {
    app,
    http: supertest(app.getHttpServer()),
    config,
    logs,
    clock,
    close: () => app.close(),
  };
}

export const VALID_PASSWORD = 'correct horse battery';

export function registerBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    email,
    password: VALID_PASSWORD,
    displayName: 'Test User',
    countryCode: 'IN',
    confirmAdult: true,
    acceptTerms: true,
    ...overrides,
  };
}

/** Extracts the session token from a Set-Cookie header list (undefined if absent or cleared). */
export function sessionTokenFrom(setCookie: string[] | string | undefined): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  for (const c of list) {
    const m = /^vantage_session=([^;]*)/.exec(c);
    if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  }
  return undefined;
}

/** Registers a user through the API and returns the session token. */
export async function registerUser(harness: Harness, email: string): Promise<string> {
  const res = await harness.http
    .post('/v1/auth/register')
    .set('Origin', WEB_ORIGIN)
    .send(registerBody(email));
  if (res.status !== 201) throw new Error(`registration failed with ${String(res.status)}`);
  return sessionTokenFrom(res.headers['set-cookie']) ?? '';
}

/** Logs an existing user in at the harness clock's current time (new session) and returns the token. */
export async function loginUser(harness: Harness, email: string): Promise<string> {
  const res = await harness.http
    .post('/v1/auth/login')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password: VALID_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed with ${String(res.status)}`);
  return sessionTokenFrom(res.headers['set-cookie']) ?? '';
}

export const cookie = (token: string): string => `vantage_session=${token}`;
