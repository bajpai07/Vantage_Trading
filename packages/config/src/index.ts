import { z } from 'zod';

export const APP_ENVS = ['local', 'test', 'staging', 'production'] as const;
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export const MARKET_DATA_SOURCES = ['FIXTURE', 'PROVIDER'] as const;

export type AppEnv = (typeof APP_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type MarketDataSource = (typeof MARKET_DATA_SOURCES)[number];

export interface Config {
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly marketDataSource: MarketDataSource;
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface ConfigIssue {
  /** Variable name. Never a value. */
  readonly name: string;
  /** The rule that was broken. Never contains a value. */
  readonly rule: string;
}

/** One aggregated error. The message lists every bad variable name and rule, never values. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration (${String(issues.length)} problem(s)):\n` +
        issues.map((i) => `  - ${i.name}: ${i.rule}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Replaces the password in a URL-like string with ***. Never throws. */
export function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.password !== '') u.password = '***';
    return u.toString();
  } catch {
    return value.replace(/:\/\/([^:/@\s]*):[^@\s]*@/, '://$1:***@');
  }
}

/** Credentials that must never reach an application process. */
const FORBIDDEN_NAMES: readonly (string | RegExp)[] = [
  'DATABASE_MIGRATOR_URL',
  'POSTGRES_SUPERUSER_PASSWORD',
  /^VANTAGE_.*_PASSWORD$/,
];
const FORBIDDEN_DB_USERS: readonly string[] = ['postgres', 'vantage_migrator'];

function isPostgresUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && u.hostname !== '';
  } catch {
    return false;
  }
}

// Every message below is a fixed rule string, so no error can echo an input value.
const schema = z.object({
  APP_ENV: z.enum(APP_ENVS, { error: `must be one of: ${APP_ENVS.join(', ')}` }),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  DATABASE_URL: z
    .string({ error: 'is required' })
    .refine(isPostgresUrl, { error: 'must be a postgres:// or postgresql:// URL' }),
  MARKET_DATA_SOURCE: z.enum(MARKET_DATA_SOURCES, {
    error: `must be one of: ${MARKET_DATA_SOURCES.join(', ')}`,
  }),
});

function dbUser(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return undefined;
  }
}

/** Pure: reads only the `env` argument, never process.env. */
export function loadConfig(env: Env): Config {
  const issues: ConfigIssue[] = [];

  const parsed = schema.safeParse({
    APP_ENV: env.APP_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE_URL: env.DATABASE_URL,
    MARKET_DATA_SOURCE: env.MARKET_DATA_SOURCE,
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.push({ name: String(i.path[0] ?? 'env'), rule: i.message });
    }
  }

  // Guard 3: apps never hold migration credentials.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    if (FORBIDDEN_NAMES.some((f) => (typeof f === 'string' ? f === key : f.test(key)))) {
      issues.push({ name: key, rule: 'must not be present in an application environment' });
    }
  }
  if (env.DATABASE_URL !== undefined) {
    const user = dbUser(env.DATABASE_URL);
    if (user !== undefined && FORBIDDEN_DB_USERS.includes(user)) {
      issues.push({
        name: 'DATABASE_URL',
        rule: `user must not be ${FORBIDDEN_DB_USERS.join(' or ')}`,
      });
    }
  }

  // Guard 1: fixtures are never allowed in staging or production.
  if (
    (env.APP_ENV === 'staging' || env.APP_ENV === 'production') &&
    env.MARKET_DATA_SOURCE === 'FIXTURE'
  ) {
    issues.push({
      name: 'MARKET_DATA_SOURCE',
      rule: 'FIXTURE is not allowed when APP_ENV is staging or production',
    });
  }

  if (!parsed.success || issues.length > 0) throw new ConfigError(issues);
  return {
    appEnv: parsed.data.APP_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
    marketDataSource: parsed.data.MARKET_DATA_SOURCE,
  };
}

export function loadConfigFromProcess(): Config {
  return loadConfig(process.env);
}
