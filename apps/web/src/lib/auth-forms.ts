// Client-side checks for the auth forms. They reuse the API's own contract schemas (so the rules are the M2 rules:
// password 10 to 128 characters, not equal to the email, adult and terms confirmed) and turn each failure into a
// plain sentence for the field. The server stays the authority: these only save a round trip.
import {
  COUNTRY_CODES,
  LoginRequest,
  PASSWORD_MAX,
  PASSWORD_MIN,
  RegisterRequest,
} from '@vantage/contracts';

export type FieldErrors = Record<string, string>;

export const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  email: 'Enter a valid email address.',
  password: `Password must be ${String(PASSWORD_MIN)} to ${String(PASSWORD_MAX)} characters and must not be your email address.`,
  displayName: 'Display name must be 2 to 40 characters.',
  countryCode: 'Choose your country.',
  confirmAdult: 'You must confirm that you are an adult.',
  acceptTerms: 'You must accept to continue.',
};

function fieldErrors(issues: readonly { path: readonly PropertyKey[] }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const name = String(i.path[0] ?? '');
    if (name !== '' && out[name] === undefined)
      out[name] = FIELD_MESSAGES[name] ?? 'Please check this field.';
  }
  return out;
}

/** Field errors for a server 400 (it names the fields it rejected). */
export function errorsForFields(fields: readonly string[]): FieldErrors {
  const out: FieldErrors = {};
  for (const f of fields) out[f] = FIELD_MESSAGES[f] ?? 'Please check this field.';
  return out;
}

export interface LoginValues {
  email: string;
  password: string;
}

export function checkLogin(
  v: LoginValues,
): { ok: true; data: LoginRequest } | { ok: false; errors: FieldErrors } {
  const r = LoginRequest.safeParse(v);
  if (r.success) return { ok: true, data: r.data };
  const errors = fieldErrors(r.error.issues);
  if (errors.password !== undefined) errors.password = 'Enter your password.';
  if (errors.email !== undefined) errors.email = 'Enter your email address.';
  return { ok: false, errors };
}

export interface RegisterValues {
  email: string;
  password: string;
  displayName: string;
  countryCode: string;
  confirmAdult: boolean;
  acceptTerms: boolean;
}

export function checkRegister(
  v: RegisterValues,
): { ok: true; data: RegisterRequest } | { ok: false; errors: FieldErrors } {
  const r = RegisterRequest.safeParse(v);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, errors: fieldErrors(r.error.issues) };
}

export { COUNTRY_CODES };
