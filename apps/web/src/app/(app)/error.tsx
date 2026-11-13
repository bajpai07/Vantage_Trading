'use client';

import { Alert, secondaryButtonClass } from '../../components/ui';

/**
 * The error state of every private page. Next hides server error details in production; the only thing shown from
 * the failure is its digest, as a support code. Never a stack trace, never raw JSON.
 */
export default function PrivateError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl py-10" data-testid="page-error">
      <Alert
        kind="error"
        support={error.digest === undefined ? null : `Support code: ${error.digest}`}
      >
        Something went wrong while loading this page. Your money and orders are not affected.
      </Alert>
      <button type="button" onClick={reset} className={`${secondaryButtonClass} mt-4`}>
        Try again
      </button>
    </div>
  );
}
