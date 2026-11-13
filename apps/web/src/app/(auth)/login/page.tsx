import type { Metadata } from 'next';
import Link from 'next/link';
import { LoginForm } from '../../../components/auth-forms';
import { safeReturnTo } from '../../../lib/return-to';

export const metadata: Metadata = { title: 'Sign in' };

/** Only this fixed set of reasons is ever shown: nothing from the query string is echoed. */
const NOTICES: Readonly<Record<string, string>> = {
  expired: 'Your session has expired. Please sign in again.',
  'signed-out': 'You have been signed out.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const reason = sp.reason;
  const returnTo = safeReturnTo(sp.next);
  const notice = typeof reason === 'string' ? (NOTICES[reason] ?? null) : null;
  return (
    <>
      <h1 className="mb-4 text-[20px] font-semibold leading-[26px] text-text-0">Sign in</h1>
      <LoginForm notice={notice} returnTo={returnTo} />
      <p className="mt-4 text-center text-[13px] text-text-2">
        New here? <Link href="/register">Create an account</Link>
      </p>
    </>
  );
}
