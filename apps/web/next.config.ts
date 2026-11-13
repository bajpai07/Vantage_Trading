import type { NextConfig } from 'next';
import { loadWebConfig } from './src/lib/config';

// Validated at startup: a bad value stops dev, build and start with a clear message (names, never values).
const config = loadWebConfig(process.env);
const secureTransport = config.appEnv === 'staging' || config.appEnv === 'production';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // D-65: the browser reaches the API only through the same-origin proxy route (src/app/api/[...path]/route.ts),
  // which reads API_BASE_URL at request time.
  // D-68: the strict, nonce-based Content-Security-Policy is set per request in src/proxy.ts. These are the
  // static security headers.
  async headers() {
    const common = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ...(secureTransport
        ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
        : []),
    ];
    return [
      { source: '/:path*', headers: common },
      // private pages and the proxied API are never stored by browsers or caches
      {
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
