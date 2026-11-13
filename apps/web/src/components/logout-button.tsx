'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientRequest } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import { secondaryButtonClass } from './ui';

/**
 * Sign out. The API revokes the session and clears the httpOnly cookie; only then does the browser leave. If the
 * session was already gone (401) that is fine too. Any other failure keeps you here with a message, because
 * pretending to be signed out while the session is still valid would be dishonest.
 */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function logout(): Promise<void> {
    setBusy(true);
    setProblem(null);
    const r = await clientRequest('POST', '/v1/auth/logout', null);
    if (r.ok || r.kind === 'unauthenticated') {
      router.replace('/login?reason=signed-out');
      router.refresh();
      return;
    }
    setBusy(false);
    setProblem(describeFailure(r, 'logout').message);
  }

  return (
    <div className="flex items-center gap-2">
      {problem === null ? null : (
        <span role="alert" className="text-[12px] text-down">
          <span aria-hidden="true">✕ </span>
          {problem}
        </span>
      )}
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        aria-busy={busy}
        className={secondaryButtonClass}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
