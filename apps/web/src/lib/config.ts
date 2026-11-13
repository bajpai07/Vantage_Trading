// Web app configuration, validated once at startup (next.config.ts imports this, so a bad value stops
// `next dev`, `next build` and `next start` with a message that names the variable and the rule, never the value).
// Pure: it reads only the `env` argument.
import { z } from 'zod';

export const APP_ENVS = ['local', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4000';
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_QUOTE_POLL_MS = 5_000;

export interface WebConfig {
  readonly appEnv: AppEnv;
  /** Origin of the API (no path, no trailing slash). The browser never uses it: it goes through /api. */
  readonly apiBaseUrl: string;
  /** Portfolio refresh interval while the tab is visible. */
  readonly portfolioPollMs: number;
  /** How often the open instrument's quote is refreshed while the tab is visible (D-73). */
  readonly quotePollMs: number;
  /**
   * D-69: pass the X-Forwarded-For header Next provides on to the API (so the API can see the real client address when it
   * trusts this server). Set it only when this app runs behind a reverse proxy you control that appends the peer
   * address (or in development): Next does NOT append the peer itself when a request already carries the header.
   * false drops the header, and the API then sees this server's own address for everyone.
   */
  readonly trustForwardedFor: boolean;
}

export class WebConfigError extends Error {
  readonly issues: readonly { readonly name: string; readonly rule: string }[];
  constructor(issues: readonly { readonly name: string; readonly rule: string }[]) {
    super(
      `Invalid web configuration (${String(issues.length)} problem(s)):\n` +
        issues.map((i) => `  - ${i.name}: ${i.rule}`).join('\n'),
    );
    this.name = 'WebConfigError';
    this.issues = issues;
  }
}

function isOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v;
  } catch {
    return false;
  }
}

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS, { error: `must be one of: ${APP_ENVS.join(', ')}` }),
  API_BASE_URL: z.string().refine(isOrigin, {
    error:
      'must be a single http(s) origin such as http://127.0.0.1:4000 (no path, no trailing slash)',
  }),
  PORTFOLIO_POLL_MS: z
    .string()
    .regex(/^[0-9]{4,6}$/, { error: 'must be a whole number of milliseconds from 1000 to 300000' })
    .transform((v) => parseInt(v, 10))
    .refine((n) => n >= 1000 && n <= 300_000, {
      error: 'must be a whole number of milliseconds from 1000 to 300000',
    }),
  QUOTE_POLL_MS: z
    .string()
    .regex(/^[0-9]{4,5}$/, { error: 'must be a whole number of milliseconds from 1000 to 60000' })
    .transform((v) => parseInt(v, 10))
    .refine((n) => n >= 1000 && n <= 60_000, {
      error: 'must be a whole number of milliseconds from 1000 to 60000',
    }),
  TRUST_FORWARDED_FOR: z.enum(['true', 'false'], { error: 'must be true or false' }),
});

export function loadWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const appEnv = env.APP_ENV ?? 'local';
  const issues: { name: string; rule: string }[] = [];
  // staging and production must say where the API is; local and test default to the local API
  if ((appEnv === 'staging' || appEnv === 'production') && env.API_BASE_URL === undefined) {
    issues.push({
      name: 'API_BASE_URL',
      rule: 'is required when APP_ENV is staging or production',
    });
  }
  // staging and production must say whether a reverse proxy in front appends the client address
  if ((appEnv === 'staging' || appEnv === 'production') && env.TRUST_FORWARDED_FOR === undefined) {
    issues.push({
      name: 'TRUST_FORWARDED_FOR',
      rule: 'is required when APP_ENV is staging or production (true only behind a reverse proxy you control)',
    });
  }
  const parsed = schema.safeParse({
    APP_ENV: appEnv,
    API_BASE_URL: env.API_BASE_URL ?? DEFAULT_API_BASE_URL,
    PORTFOLIO_POLL_MS: env.PORTFOLIO_POLL_MS ?? String(DEFAULT_POLL_MS),
    QUOTE_POLL_MS: env.QUOTE_POLL_MS ?? String(DEFAULT_QUOTE_POLL_MS),
    TRUST_FORWARDED_FOR: env.TRUST_FORWARDED_FOR ?? 'true',
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.push({ name: String(i.path[0] ?? 'env'), rule: i.message });
    }
  }
  if (issues.length > 0 || !parsed.success) throw new WebConfigError(issues);
  return {
    appEnv: parsed.data.APP_ENV,
    apiBaseUrl: parsed.data.API_BASE_URL,
    portfolioPollMs: parsed.data.PORTFOLIO_POLL_MS,
    quotePollMs: parsed.data.QUOTE_POLL_MS,
    trustForwardedFor: parsed.data.TRUST_FORWARDED_FOR === 'true',
  };
}

let cached: WebConfig | undefined;
/** The configuration of this process (server side only; the browser never sees it). */
export function getWebConfig(): WebConfig {
  cached ??= loadWebConfig(process.env);
  return cached;
}
