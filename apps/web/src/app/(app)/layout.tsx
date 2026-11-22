import Link from 'next/link';
import { AppNav } from '../../components/app-nav';
import { BfcacheGuard } from '../../components/bfcache-guard';
import { Brand } from '../../components/brand';
import { LogoutButton } from '../../components/logout-button';
import { SearchBox } from '../../components/search-box';
import { requireSession } from '../../lib/server-api';

/**
 * Everything under (app) is private. The session is checked here on the server for every request (D-66): without
 * one the visitor is redirected to the login page before any private page is rendered.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireSession();
  return (
    <>
      <BfcacheGuard />
      <header className="sticky top-0 z-20 border-b border-line bg-bg-1">
        <div className="mx-auto flex min-h-10 max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-1.5">
          <Link
            href="/portfolio"
            aria-label="VANTAGE, go to portfolio"
            className="text-text-0 hover:text-text-0"
          >
            <Brand />
          </Link>
          <AppNav />
          {/* a full-width second row on phones, the middle of the top bar from 768 px */}
          <div className="order-last w-full md:order-none md:flex md:w-auto md:flex-1 md:justify-center">
            <SearchBox />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span
              data-testid="user-name"
              className="hidden max-w-40 truncate text-[12px] text-text-2 sm:inline"
            >
              {me.displayName}
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>
      {me.email.endsWith('@demo.invalid') ? (
        <p
          data-testid="demo-notice"
          className="border-b border-line bg-bg-2 px-4 py-1 text-center text-[12px] text-text-1"
        >
          You are using a temporary demo account. It cannot be recovered after you sign out.
        </p>
      ) : null}
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-4 md:pb-6">
        {children}
      </main>
    </>
  );
}
