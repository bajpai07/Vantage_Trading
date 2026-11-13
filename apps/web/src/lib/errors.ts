// Friendly, specific messages for API failures (DESIGN_SYSTEM section 8: errors are specific, not generic). Nothing
// from an API error body is shown except through these sentences; the support code (request id) is the only internal
// detail a user ever sees.
import type { ApiFailure } from './api-core';

export interface FailureMessage {
  readonly message: string;
  /** "Support code: ..." line, or null when there is none. */
  readonly support: string | null;
}

/** "45 seconds", "2 minutes", "1 hour": a retry hint a person can act on. */
export function humanDuration(seconds: number): string {
  if (seconds < 90) return seconds <= 1 ? '1 second' : `${String(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${String(minutes)} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

export type FailureContext = 'login' | 'register' | 'load' | 'logout';

export function describeFailure(f: ApiFailure, context: FailureContext = 'load'): FailureMessage {
  const support = f.supportCode === null ? null : `Support code: ${f.supportCode}`;
  const msg = (message: string): FailureMessage => ({ message, support });
  switch (f.kind) {
    case 'network':
      return msg("We can't reach the server. Check your connection and try again.");
    case 'server':
      return msg('Something went wrong on our side. Please try again in a moment.');
    case 'rate_limited':
      return msg(
        f.retryAfterSeconds === null
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : `Too many attempts. Please wait ${humanDuration(f.retryAfterSeconds)} and try again.`,
      );
    case 'invalid_credentials':
      return msg('Wrong email or password.');
    case 'unauthenticated':
      return msg(
        context === 'login'
          ? 'Wrong email or password.'
          : 'Your session has expired. Please sign in again.',
      );
    case 'conflict':
      return msg(
        f.code === 'EMAIL_TAKEN'
          ? 'An account with this email already exists. Try signing in instead.'
          : 'That conflicts with something that already exists. Please check and try again.',
      );
    case 'forbidden':
      return msg('Your request was blocked for security reasons. Reload the page and try again.');
    case 'validation':
      return msg('Please check the form and try again.');
    case 'not_found':
      return msg(
        context === 'load' ? 'We could not find that.' : 'Something went wrong. Please try again.',
      );
    case 'invalid_response':
      return msg(
        'We received an unexpected answer from the server, so nothing was shown. Please try again.',
      );
    default:
      return msg('Something went wrong. Please try again.');
  }
}
