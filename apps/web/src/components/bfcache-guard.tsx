'use client';

import { useEffect } from 'react';

/**
 * Private pages are served `Cache-Control: no-store`, so the browser should never restore them from its back/forward
 * cache. Some browsers still may; when a page is restored that way, reload it so the server decides again (after a
 * sign-out the reload lands on the login page and no private data is shown).
 */
export function BfcacheGuard() {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);
  return null;
}
