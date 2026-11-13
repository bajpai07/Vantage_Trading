/**
 * D-68: the strict Content-Security-Policy, built per request with a fresh nonce. No inline script runs unless it
 * carries the nonce (Next applies it to its own scripts), `strict-dynamic` lets those load their chunks, and
 * nothing may frame the app. Development additionally needs 'unsafe-eval' (React debugging); production does not.
 * `upgrade-insecure-requests` only where the app is served over TLS.
 */
export function buildCsp(opts: { nonce: string; dev: boolean; tls: boolean }): string {
  const { nonce, dev, tls } = opts;
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(tls ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

/** A fresh, unpredictable nonce for one response. */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
