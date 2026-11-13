// Where to go after signing in. Only a short list of our own pages is ever accepted (an open redirect would let a
// crafted link send a freshly signed-in user to another site), and anything else means the portfolio.
const ALLOWED = /^\/(?:portfolio|orders|activity|instruments\/[A-Za-z0-9][A-Za-z0-9.-]{0,14})$/;

export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && ALLOWED.test(value) ? value : '/portfolio';
}

/** The login URL that brings the user back to `path` afterwards (for a session that expired in the middle of something). */
export function loginUrlFor(path: string): string {
  const next = safeReturnTo(path);
  return next === '/portfolio' && path !== '/portfolio'
    ? '/login?reason=expired'
    : `/login?reason=expired&next=${encodeURIComponent(next)}`;
}
