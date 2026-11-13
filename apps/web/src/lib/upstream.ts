// Pure helpers for the same-origin API proxy (src/app/api/[...path]/route.ts, D-65). Kept free of Next and fetch so
// they can be tested exhaustively: which paths may be proxied, and which headers cross in each direction.

/** Only the API's own versioned routes (and its health check) are reachable through the proxy. */
export function isAllowedPath(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  if (
    segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('%'))
  ) {
    return false;
  }
  const first = segments[0];
  return first === 'v1' || (first === 'health' && segments.length <= 2);
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers sent on to the API: everything the browser sent except hop-by-hop headers and the ones fetch owns.
 * X-Forwarded-For (D-69) is passed on only when `trustForwardedFor` is set; otherwise it is dropped, and so are the
 * other headers that could claim a client address (Forwarded, X-Real-IP, ...), so the API falls back to this server's
 * own address rather than to something a client chose.
 */
export function upstreamRequestHeaders(
  incoming: Headers,
  options: { trustForwardedFor: boolean },
): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === 'host' || k === 'content-length' || k === 'accept-encoding')
      return;
    if (k === 'forwarded' || k === 'x-real-ip' || k === 'x-client-ip' || k === 'true-client-ip')
      return;
    if (k === 'x-forwarded-for' && !options.trustForwardedFor) return;
    out.append(key, value);
  });
  return out;
}

/**
 * Response headers sent back to the browser: the API's own (cookies, request id, retry hints, content type), minus
 * hop-by-hop headers and the encoding and length headers that no longer describe the decoded body.
 */
export function downstreamResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      HOP_BY_HOP.has(k) ||
      k === 'content-encoding' ||
      k === 'content-length' ||
      k === 'set-cookie'
    )
      return;
    out.append(key, value);
  });
  // Set-Cookie must stay one header per cookie
  for (const cookie of upstream.getSetCookie()) out.append('set-cookie', cookie);
  return out;
}
