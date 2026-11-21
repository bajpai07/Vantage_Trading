'use client';
// Browser-side API access. The browser only ever talks to its own origin: `/api/*` is proxied to the API by Next
// (D-65), so the httpOnly session cookie travels automatically, the API's Origin check sees this app's origin, and no
// token is ever readable by script or stored anywhere. Every answer is validated against the contracts.
import type { ZodType } from 'zod';
import { interpretResponse, networkFailure } from './api-core';
import type { ApiResult } from './api-core';

const TIMEOUT_MS = 15_000;

export async function clientRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  schema: ZodType<T> | null,
  options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(TIMEOUT_MS)
          : AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), options.signal]),
    });
    return await interpretResponse(res, schema);
  } catch {
    return networkFailure();
  }
}

export const clientGet = <T>(
  path: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
): Promise<ApiResult<T>> =>
  clientRequest('GET', path, schema, signal === undefined ? {} : { signal });
