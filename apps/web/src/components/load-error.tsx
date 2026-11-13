'use client';

import { useRouter } from 'next/navigation';
import type { ApiFailure } from '../lib/api-core';
import { describeFailure } from '../lib/errors';
import { Alert, secondaryButtonClass } from './ui';

/** The error state of a screen whose data could not be loaded: a plain sentence, the support code, and a retry. */
export function LoadError({ failure, what }: { failure: ApiFailure; what: string }) {
  const router = useRouter();
  const m = describeFailure(failure, 'load');
  return (
    <div className="mx-auto max-w-xl py-6" data-testid="load-error">
      <h1 className="mb-3 text-[20px] font-semibold leading-[26px] text-text-0">{what}</h1>
      <Alert kind="error" support={m.support}>
        {m.message}
      </Alert>
      <button
        type="button"
        onClick={() => router.refresh()}
        className={`${secondaryButtonClass} mt-4`}
      >
        Try again
      </button>
    </div>
  );
}
