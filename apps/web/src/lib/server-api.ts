// Server-side API access (server components and the proxy of the session). The session cookie of the incoming request
// is forwarded to the API; nothing here is ever sent to the browser except what the pages render from validated data.
// Do not import this file from a client component (it reads the request cookies).
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { MeResponse } from '@vantage/contracts';
import type { ZodType } from 'zod';
import { interpretResponse, networkFailure } from './api-core';
import type { ApiResult } from './api-core';
import { getWebConfig } from './config';

const SESSION_COOKIE = 'vantage_session';

/** GET from the API as the signed-in user. The answer is validated against `schema` or becomes a safe failure. */
export async function serverGet<T>(path: string, schema: ZodType<T>): Promise<ApiResult<T>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  try {
    const res = await fetch(`${getWebConfig().apiBaseUrl}${path}`, {
      headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    return await interpretResponse(res, schema);
  } catch {
    return networkFailure();
  }
}

/** Who is signed in (null when nobody is). One API call per request, however many components ask. */
export const getSession = cache(async (): Promise<MeResponse | null> => {
  const r = await serverGet('/v1/me', MeResponse);
  return r.ok ? r.data : null;
});

/**
 * D-66: server-side route protection. A page calls this first; without a valid session the visitor is redirected to
 * the login page before any private data is fetched or rendered. (The proxy does the same one step earlier.)
 */
export async function requireSession(): Promise<MeResponse> {
  const me = await getSession();
  if (me === null) redirect('/login?reason=expired');
  return me;
}
