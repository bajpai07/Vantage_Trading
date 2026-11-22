import type { Metadata } from 'next';
import Link from 'next/link';
import { COUNTRY_CODES } from '@vantage/contracts';
import { RegisterForm } from '../../../components/auth-forms';
import { DemoButton } from '../../../components/demo-button';
import { getWebConfig } from '../../../lib/config';

export const metadata: Metadata = { title: 'Create account' };

/** Country names are computed on the server (one source for the options, so server and browser always agree). */
function countryOptions(): Array<{ code: string; name: string }> {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
}

export default function RegisterPage() {
  return (
    <>
      <h1 className="mb-1 text-[20px] font-semibold leading-[26px] text-text-0">
        Create your account
      </h1>
      <p className="mb-4 text-[13px] text-text-2">
        You start with $10,000 of virtual money. Nothing here is real trading.
      </p>
      <RegisterForm countries={countryOptions()} />
      <p className="mt-4 text-center text-[13px] text-text-2">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
      <DemoButton enabled={getWebConfig().demoAccounts} />
    </>
  );
}
