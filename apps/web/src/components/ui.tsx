import type { ReactNode } from 'react';

/** Shared form and feedback primitives. Colours come only from the design tokens (Tailwind theme). */

export const inputClass =
  'block w-full rounded-md border border-line bg-bg-2 px-3 py-2 text-[14px] leading-5 text-text-0 placeholder:text-text-2 aria-[invalid=true]:border-down disabled:opacity-60';

export const primaryButtonClass =
  'inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 py-2 text-[14px] font-semibold text-bg-0 hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9';

export const secondaryButtonClass =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-bg-2 px-3 py-1.5 text-[13px] font-medium text-text-0 hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-60 md:min-h-8';

export function Field(props: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  const { id, label, error, hint, children } = props;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-text-0">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="mt-1 text-[12px] text-text-2">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="mt-1 text-[12px] font-medium text-down">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      )}
    </div>
  );
}

/** Error or notice with a text prefix (never colour alone). `support` is the request id as a "support code" line. */
export function Alert(props: {
  kind: 'error' | 'info';
  children: ReactNode;
  support?: string | null | undefined;
  id?: string;
  testId?: string;
}) {
  const { kind, children, support, id, testId } = props;
  const isError = kind === 'error';
  return (
    <div
      id={id}
      role={isError ? 'alert' : 'status'}
      tabIndex={-1}
      data-testid={testId ?? (isError ? 'error-message' : 'notice')}
      className={`rounded-md border px-3 py-2 text-[13px] ${
        isError ? 'border-down bg-down-bg text-text-0' : 'border-info bg-bg-2 text-text-0'
      }`}
    >
      <p>
        <strong className={isError ? 'text-down' : 'text-info'}>
          {isError ? 'Error: ' : 'Note: '}
        </strong>
        {children}
      </p>
      {support === null || support === undefined ? null : (
        <p className="num mt-1 text-[12px] text-text-2">{support}</p>
      )}
    </div>
  );
}

/** A fixed-size placeholder row: loading states never shift the layout (DESIGN_SYSTEM section 8). */
export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" data-testid="loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mb-1 h-7 rounded-sm bg-bg-2 motion-safe:animate-pulse" />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      data-testid="empty-state"
      className="rounded-md border border-dashed border-line-strong bg-bg-1 px-4 py-8 text-center"
    >
      <p className="text-[16px] font-semibold text-text-0">{title}</p>
      {children === undefined ? null : <p className="mt-1 text-[13px] text-text-2">{children}</p>}
    </div>
  );
}
