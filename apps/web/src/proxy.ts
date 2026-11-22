// Runs before every page request (Next 16 "proxy", Node runtime). Two jobs:
//  1. D-66: route protection happens HERE and in the pages, on the server, by asking the API who the caller is:
//     no valid session -> /login; a signed-in user on /login or /register -> /portfolio. Hiding UI is not protection.
//  2. D-68: the strict nonce-based Content-Security-Policy, plus Cache-Control: no-store so private pages are never
//     kept by the browser (the back button after logout cannot show them).
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildCsp, newNonce } from './lib/csp';
import { getWebConfig } from './lib/config';

const SESSION_COOKIE = 'vantage_session';
const AUTH_PAGES = new Set(['/login', '/register']);
/** Pages anyone may read, signed in or not (the licence notices of the chart library, D-103). */
const PUBLIC_PAGES = new Set(['/third-party-notices', '/about']);

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token === undefined || token === '') return false; // no cookie: no need to ask
  try {
    const res = await fetch(`${getWebConfig().apiBaseUrl}/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false; // when the API cannot be asked, nobody is treated as signed in
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const authed = await hasValidSession(request);
  const isAuthPage = AUTH_PAGES.has(pathname);

  let response: NextResponse;
  if (pathname === '/') {
    response = NextResponse.redirect(new URL(authed ? '/portfolio' : '/login', request.url));
  } else if (!authed && !isAuthPage && !PUBLIC_PAGES.has(pathname)) {
    response = NextResponse.redirect(new URL('/login', request.url));
  } else if (authed && isAuthPage) {
    response = NextResponse.redirect(new URL('/portfolio', request.url));
  } else {
    const config = getWebConfig();
    const nonce = newNonce();
    const csp = buildCsp({
      nonce,
      dev: process.env.NODE_ENV === 'development',
      tls: config.appEnv === 'staging' || config.appEnv === 'production',
    });
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('Content-Security-Policy', csp);
    response = NextResponse.next({ request: { headers } });
    response.headers.set('Content-Security-Policy', csp);
  }
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  // not the proxied API (/api), not Next's static files, not prefetches
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
