'use client';

// "Try the demo" (M10, D-113): creates a FRESH temporary account through the normal registration endpoint and signs in. The address is a
// generated, unguessable one on the reserved non-routable domain demo.invalid, and the password is random: both are made in this
// browser, used once, and never shown, stored, logged or put in a URL. Every normal rule applies (validation, the per-address rate
// limits: a 429 is shown with the usual friendly message). The ledger is append-only, so these accounts are never deleted.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MeResponse } from '@vantage/contracts';
import { clientRequest } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import type { FailureMessage } from '../lib/errors';
import { Alert, secondaryButtonClass } from './ui';

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export function DemoButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FailureMessage | null>(null);
  if (!enabled) return null;

  async function go(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const hex = [...random(10)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const body = {
      email: `demo-${hex}@demo.invalid`,
      password: `${b64url(random(24))}aA1`,
      displayName: 'Demo visitor',
      countryCode: 'IN',
      confirmAdult: true,
      acceptTerms: true,
    };
    const r = await clientRequest('POST', '/v1/auth/register', MeResponse, { body });
    if (r.ok) {
      router.replace('/portfolio');
      router.refresh();
      return;
    }
    setBusy(false);
    setProblem(describeFailure(r, 'register'));
  }

  return (
    <section
      aria-labelledby="demo-title"
      data-testid="demo-section"
      className="mt-6 rounded-md border border-line bg-bg-1 p-4"
    >
      <h2 id="demo-title" className="mb-1 text-[14px] font-semibold text-text-0">
        Just looking?
      </h2>
      <p className="mb-3 text-[13px] text-text-1">
        Try VANTAGE with a temporary demo account: no email, no password to remember, $10,000 of
        virtual money. It cannot be recovered after you sign out.
      </p>
      {problem === null ? null : (
        <div className="mb-3" data-testid="demo-problem">
          <Alert kind="error" support={problem.support}>
            {problem.message}
          </Alert>
        </div>
      )}
      <button
        type="button"
        data-testid="demo-button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void go()}
        className={`${secondaryButtonClass} w-full`}
      >
        {busy ? 'Creating a demo account…' : 'Try the demo'}
      </button>
      <p className="mt-2 text-[12px] text-text-2">
        By continuing you confirm you are an adult and accept the terms: virtual money, simulated
        prices, not real trading.
      </p>
    </section>
  );
}
