import Link from 'next/link';
import { Brand } from '../../components/brand';

/** Sign-in and registration: a single centred panel, no navigation (there is nothing private to navigate to). */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10"
    >
      <div className="mb-6 text-center">
        <Link
          href="/login"
          aria-label="VANTAGE home"
          className="inline-block text-text-0 hover:text-text-0"
        >
          <Brand />
        </Link>
        <p className="mt-2 text-[13px] text-text-2">
          Virtual money, real market data. Not a brokerage.
        </p>
      </div>
      <div className="rounded-lg border border-line bg-bg-1 p-6">{children}</div>
    </main>
  );
}
