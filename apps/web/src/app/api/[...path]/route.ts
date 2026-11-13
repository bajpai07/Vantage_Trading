// D-65: the browser talks to the API same-origin through this proxy. The vantage_session cookie therefore stays
// httpOnly and SameSite=Lax on the web origin, the API's Origin-header CSRF check sees the web origin on every
// state-changing request, and no CORS is opened on the API. The API address is read at request time from the
// validated configuration (no rebuild to move it). Bodies stream through; nothing is cached or logged.
import type { NextRequest } from 'next/server';
import { getWebConfig } from '../../../lib/config';
import {
  downstreamResponseHeaders,
  isAllowedPath,
  upstreamRequestHeaders,
} from '../../../lib/upstream';

export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 20_000;

async function forward(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  if (!isAllowedPath(path)) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'web-proxy' } },
      { status: 404 },
    );
  }
  const url = `${getWebConfig().apiBaseUrl}/${path.join('/')}${req.nextUrl.search}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: upstreamRequestHeaders(req.headers),
      ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    } as RequestInit);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: downstreamResponseHeaders(upstream.headers),
    });
  } catch {
    // The API could not be reached: a safe, generic answer in the API's own error shape.
    return Response.json(
      {
        error: {
          code: 'BAD_GATEWAY',
          message: 'The service is unavailable',
          requestId: 'web-proxy',
        },
      },
      { status: 502 },
    );
  }
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
