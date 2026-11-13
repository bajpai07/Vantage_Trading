// The one place API responses are interpreted, on the server and in the browser. Every success body is validated
// against the @vantage/contracts Zod schema before anything can render it; a body that does not match becomes
// `invalid_response` (a safe error), never unvalidated data. Error bodies are reduced to a kind, a code and a
// support code (the request id): raw JSON, messages from the API and stack traces never reach the screen.
import { ErrorEnvelope } from '@vantage/contracts';
import type { ZodType } from 'zod';

export type ApiFailureKind =
  | 'unauthenticated' // 401 UNAUTHENTICATED (session missing, expired, revoked)
  | 'invalid_credentials' // 401 INVALID_CREDENTIALS
  | 'forbidden' // 403
  | 'validation' // 400
  | 'not_found' // 404
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'network' // the request never got an answer
  | 'invalid_response' // a 2xx whose body does not match the contract
  | 'unknown';

export interface ApiFailure {
  readonly ok: false;
  readonly kind: ApiFailureKind;
  /** HTTP status, or 0 when there was no response. */
  readonly status: number;
  /** The API's stable error code, e.g. EMAIL_TAKEN, when it sent one. */
  readonly code: string | null;
  /** Seconds to wait (429 only). */
  readonly retryAfterSeconds: number | null;
  /** The request id: shown as "Support code", the only internal detail a user ever sees. */
  readonly supportCode: string | null;
  /** Names of the fields a 400 VALIDATION_ERROR complained about (never their values). */
  readonly fields: readonly string[];
}

export type ApiSuccess<T> = { readonly ok: true; readonly status: number; readonly data: T };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

const failure = (f: Partial<ApiFailure> & Pick<ApiFailure, 'kind' | 'status'>): ApiFailure => ({
  ok: false,
  code: null,
  retryAfterSeconds: null,
  supportCode: null,
  fields: [],
  ...f,
});

export const networkFailure = (): ApiFailure => failure({ kind: 'network', status: 0 });

function kindFor(status: number, code: string | null): ApiFailureKind {
  if (status === 401)
    return code === 'INVALID_CREDENTIALS' ? 'invalid_credentials' : 'unauthenticated';
  if (status === 400) return 'validation';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** "Invalid request: email, password" -> ['email', 'password'] (the API names fields, never values). */
export function fieldsFromMessage(message: string): string[] {
  const i = message.indexOf(':');
  if (i < 0) return [];
  return message
    .slice(i + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z][A-Za-z0-9.]*$/.test(s));
}

/** Seconds from a Retry-After header (whole seconds only); null when absent or not a plain whole number. */
export function retryAfterSeconds(header: string | null): number | null {
  if (header === null || !/^[0-9]{1,6}$/.test(header.trim())) return null;
  return parseInt(header.trim(), 10);
}

/**
 * Turns a fetch Response into an ApiResult. With a schema the success body is validated; with `null` the body is
 * ignored (204 No Content, or a call whose answer is not needed).
 */
export async function interpretResponse<T>(
  res: Response,
  schema: ZodType<T> | null,
): Promise<ApiResult<T>> {
  const headerId = res.headers.get('x-request-id');
  if (res.ok) {
    if (schema === null) return { ok: true, status: res.status, data: undefined as T };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return failure({ kind: 'invalid_response', status: res.status, supportCode: headerId });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return failure({ kind: 'invalid_response', status: res.status, supportCode: headerId });
    }
    return { ok: true, status: res.status, data: parsed.data };
  }
  let code: string | null = null;
  let supportCode: string | null = headerId;
  let fields: string[] = [];
  try {
    const env = ErrorEnvelope.safeParse(await res.json());
    if (env.success) {
      code = env.data.error.code;
      supportCode = env.data.error.requestId;
      if (res.status === 400) fields = fieldsFromMessage(env.data.error.message);
    }
  } catch {
    // not JSON: only the status is used
  }
  return failure({
    kind: kindFor(res.status, code),
    status: res.status,
    code,
    supportCode,
    fields,
    retryAfterSeconds:
      res.status === 429 ? retryAfterSeconds(res.headers.get('retry-after')) : null,
  });
}
