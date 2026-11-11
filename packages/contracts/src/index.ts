// Zod schemas shared by the API (and later the web app). Depends on no internal package.
// All money fields are decimal STRINGS, never numbers.
import { z } from 'zod';
import { COUNTRY_CODES } from './countries.js';
import { MoneyString } from './money-string.js';

export { COUNTRY_CODES } from './countries.js';
export type { CountryCode } from './countries.js';
export { MoneyString } from './money-string.js';

/** Trim, lower-case: the form used for comparisons and rate-limit keys. The stored email is only trimmed. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const email = z.string().trim().pipe(z.email().max(254));

export const RegisterRequest = z
  .strictObject({
    email,
    password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
    displayName: z.string().trim().min(2).max(40),
    countryCode: z
      .string()
      .transform((s) => s.toUpperCase())
      .pipe(z.enum(COUNTRY_CODES)),
    confirmAdult: z.literal(true),
    acceptTerms: z.literal(true),
  })
  .superRefine((value, ctx) => {
    if (value.password.trim().toLowerCase() === normalizeEmail(value.email)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'must not equal the email' });
    }
  });
export type RegisterRequest = z.output<typeof RegisterRequest>;

export const LoginRequest = z.strictObject({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginRequest = z.output<typeof LoginRequest>;

export const UserRole = z.enum(['USER', 'SUPPORT', 'ADMIN', 'SUPERADMIN']);
export const UserStatus = z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED']);

export const MeResponse = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  countryCode: z.string().length(2).nullable(),
  role: UserRole,
  status: UserStatus,
});
export type MeResponse = z.output<typeof MeResponse>;

export const AccountResponse = z.strictObject({
  currency: z.literal('USD'),
  cash: MoneyString,
  equity: MoneyString,
  initialCapital: MoneyString,
  asOf: z.iso.datetime(),
});
export type AccountResponse = z.output<typeof AccountResponse>;

export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.output<typeof ErrorEnvelope>;

export * from './market.js';
