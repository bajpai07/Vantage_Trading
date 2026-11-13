import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from './csp';

describe('buildCsp (D-68)', () => {
  const prod = buildCsp({ nonce: 'abc123', dev: false, tls: true });

  it('allows scripts only from self, with the nonce and strict-dynamic; never unsafe-inline or unsafe-eval in production', () => {
    expect(prod).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(prod).not.toContain('unsafe-inline');
    expect(prod).not.toContain('unsafe-eval');
  });

  it('forbids framing, plugins, foreign forms and base tags, and loads everything else from the same origin', () => {
    for (const d of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "connect-src 'self'",
      "font-src 'self'",
    ]) {
      expect(prod).toContain(d);
    }
    expect(prod).not.toMatch(/https?:\/\//); // no foreign origin is allowed anywhere
  });

  it('upgrades insecure requests only where TLS is used (control: local http is not broken)', () => {
    expect(prod).toContain('upgrade-insecure-requests');
    expect(buildCsp({ nonce: 'n', dev: false, tls: false })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it("development adds 'unsafe-eval' (React debugging) and production does not (control)", () => {
    expect(buildCsp({ nonce: 'n', dev: true, tls: false })).toContain("'unsafe-eval'");
    expect(prod).not.toContain("'unsafe-eval'");
  });

  it('newNonce is fresh for every call and base64', () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });
});
