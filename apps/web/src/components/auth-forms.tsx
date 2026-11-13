'use client';

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { MeResponse } from '@vantage/contracts';
import { checkLogin, checkRegister, errorsForFields } from '../lib/auth-forms';
import type { FieldErrors } from '../lib/auth-forms';
import { clientRequest } from '../lib/client-api';
import { describeFailure } from '../lib/errors';
import type { FailureMessage } from '../lib/errors';
import { Alert, Field, inputClass, primaryButtonClass } from './ui';

/**
 * Both forms: accessible labels, inline errors tied to their fields (aria-invalid and aria-describedby), the submit
 * button disabled while the request runs, no password in a URL (method post, JSON body) and none in any log.
 */

function useFormState() {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<FailureMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const alertRef = useRef<HTMLDivElement | null>(null);
  return { errors, setErrors, failure, setFailure, submitting, setSubmitting, alertRef };
}

function describedBy(id: string, errors: FieldErrors, hint = false): string | undefined {
  const ids = [hint ? `${id}-hint` : null, errors[id] === undefined ? null : `${id}-error`].filter(
    (x): x is string => x !== null,
  );
  return ids.length === 0 ? undefined : ids.join(' ');
}

export function LoginForm({ notice }: { notice: string | null }) {
  const router = useRouter();
  const s = useFormState();

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const checked = checkLogin({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    s.setFailure(null);
    if (!checked.ok) {
      s.setErrors(checked.errors);
      return;
    }
    s.setErrors({});
    s.setSubmitting(true);
    const r = await clientRequest('POST', '/v1/auth/login', MeResponse, { body: checked.data });
    if (r.ok) {
      router.replace('/portfolio');
      router.refresh();
      return; // stay disabled until the navigation completes
    }
    s.setSubmitting(false);
    s.setFailure(describeFailure(r, 'login'));
    s.setErrors(errorsForFields(r.fields));
    queueMicrotask(() => s.alertRef.current?.focus());
  }

  return (
    <form method="post" noValidate onSubmit={(e) => void onSubmit(e)} aria-label="Sign in">
      {notice === null ? null : (
        <div className="mb-4">
          <Alert kind="info">{notice}</Alert>
        </div>
      )}
      {s.failure === null ? null : (
        <div className="mb-4" ref={s.alertRef} tabIndex={-1}>
          <Alert kind="error" support={s.failure.support}>
            {s.failure.message}
          </Alert>
        </div>
      )}
      <Field id="email" label="Email" error={s.errors.email}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={s.submitting}
          aria-invalid={s.errors.email !== undefined}
          aria-describedby={describedBy('email', s.errors)}
          className={inputClass}
        />
      </Field>
      <Field id="password" label="Password" error={s.errors.password}>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={s.submitting}
          aria-invalid={s.errors.password !== undefined}
          aria-describedby={describedBy('password', s.errors)}
          className={inputClass}
        />
      </Field>
      <button
        type="submit"
        disabled={s.submitting}
        aria-busy={s.submitting}
        className={`${primaryButtonClass} w-full`}
      >
        {s.submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export function RegisterForm({
  countries,
}: {
  countries: ReadonlyArray<{ code: string; name: string }>;
}) {
  const router = useRouter();
  const s = useFormState();

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      displayName: String(form.get('displayName') ?? ''),
      countryCode: String(form.get('countryCode') ?? ''),
      confirmAdult: form.get('confirmAdult') === 'on',
      acceptTerms: form.get('acceptTerms') === 'on',
    };
    s.setFailure(null);
    const checked = checkRegister(values);
    if (!checked.ok) {
      s.setErrors(checked.errors);
      return;
    }
    s.setErrors({});
    s.setSubmitting(true);
    const r = await clientRequest('POST', '/v1/auth/register', MeResponse, { body: checked.data });
    if (r.ok) {
      router.replace('/portfolio');
      router.refresh();
      return;
    }
    s.setSubmitting(false);
    s.setFailure(describeFailure(r, 'register'));
    s.setErrors(errorsForFields(r.fields));
    if (r.code === 'EMAIL_TAKEN') s.setErrors({ email: 'This email is already registered.' });
    queueMicrotask(() => s.alertRef.current?.focus());
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Create your account"
    >
      {s.failure === null ? null : (
        <div className="mb-4" ref={s.alertRef} tabIndex={-1}>
          <Alert kind="error" support={s.failure.support}>
            {s.failure.message}
          </Alert>
        </div>
      )}
      <Field id="email" label="Email" error={s.errors.email}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={s.submitting}
          aria-invalid={s.errors.email !== undefined}
          aria-describedby={describedBy('email', s.errors)}
          className={inputClass}
        />
      </Field>
      <Field
        id="password"
        label="Password"
        hint="10 to 128 characters. It must not be your email address."
        error={s.errors.password}
      >
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          disabled={s.submitting}
          aria-invalid={s.errors.password !== undefined}
          aria-describedby={describedBy('password', s.errors, true)}
          className={inputClass}
        />
      </Field>
      <Field
        id="displayName"
        label="Display name"
        hint="2 to 40 characters."
        error={s.errors.displayName}
      >
        <input
          id="displayName"
          name="displayName"
          type="text"
          autoComplete="nickname"
          required
          disabled={s.submitting}
          aria-invalid={s.errors.displayName !== undefined}
          aria-describedby={describedBy('displayName', s.errors, true)}
          className={inputClass}
        />
      </Field>
      <Field id="countryCode" label="Country" error={s.errors.countryCode}>
        <select
          id="countryCode"
          name="countryCode"
          autoComplete="country"
          required
          defaultValue=""
          disabled={s.submitting}
          aria-invalid={s.errors.countryCode !== undefined}
          aria-describedby={describedBy('countryCode', s.errors)}
          className={inputClass}
        >
          <option value="" disabled>
            Choose your country
          </option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="mb-4">
        <label className="flex min-h-11 items-start gap-2 text-[13px] text-text-1 md:min-h-0">
          <input
            type="checkbox"
            name="confirmAdult"
            disabled={s.submitting}
            aria-invalid={s.errors.confirmAdult !== undefined}
            aria-describedby={describedBy('confirmAdult', s.errors)}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>I confirm that I am an adult.</span>
        </label>
        {s.errors.confirmAdult === undefined ? null : (
          <p id="confirmAdult-error" className="mt-1 text-[12px] font-medium text-down">
            <span aria-hidden="true">✕ </span>
            {s.errors.confirmAdult}
          </p>
        )}
      </div>
      <div className="mb-4">
        <label className="flex min-h-11 items-start gap-2 text-[13px] text-text-1 md:min-h-0">
          <input
            type="checkbox"
            name="acceptTerms"
            disabled={s.submitting}
            aria-invalid={s.errors.acceptTerms !== undefined}
            aria-describedby={describedBy('acceptTerms', s.errors)}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>I accept the terms and understand this is virtual money, not real trading.</span>
        </label>
        {s.errors.acceptTerms === undefined ? null : (
          <p id="acceptTerms-error" className="mt-1 text-[12px] font-medium text-down">
            <span aria-hidden="true">✕ </span>
            {s.errors.acceptTerms}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={s.submitting}
        aria-busy={s.submitting}
        className={`${primaryButtonClass} w-full`}
      >
        {s.submitting ? 'Creating your account…' : 'Create account'}
      </button>
    </form>
  );
}
