'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV_ITEMS = [
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/instruments/AAPL', label: 'Trade', match: '/instruments' },
  { href: '/orders', label: 'Orders' },
  { href: '/activity', label: 'Activity' },
] as const;

/**
 * Primary navigation. A top bar link row on wide screens, a bottom tab bar below 768 px (DESIGN_SYSTEM section 5).
 * The current page is marked with aria-current and an underline, not by colour alone. Touch targets are 44 px tall on
 * small screens.
 */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-bg-1 pb-[env(safe-area-inset-bottom)] md:static md:pb-0 md:z-auto md:border-t-0 md:bg-transparent"
    >
      <ul className="flex w-full md:w-auto md:gap-1">
        {NAV_ITEMS.map((item) => {
          const base = 'match' in item ? item.match : item.href;
          const current = pathname === base || pathname.startsWith(`${base}/`);
          return (
            <li key={item.href} className="flex-1 md:flex-none">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`flex min-h-12 items-center justify-center border-t-2 px-3 text-[13px] font-medium md:min-h-10 md:border-b-2 md:border-t-0 ${
                  current
                    ? 'border-accent text-text-0'
                    : 'border-transparent text-text-1 hover:bg-bg-3 hover:text-text-0'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
