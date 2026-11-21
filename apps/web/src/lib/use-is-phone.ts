'use client';
// Phone = a viewport narrower than 768 px (D-107). `null` until the browser has been asked (the server cannot know): a component
// that differs between phone and desktop renders a reserved-size placeholder while it is null, then the right variant. The
// ticket does NOT use this: it is one element whose presentation changes with CSS, so a rotation can never remount it (D-108).
import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  const m = window.matchMedia(PHONE_QUERY);
  m.addEventListener('change', onChange);
  return () => m.removeEventListener('change', onChange);
}

export function useIsPhone(): boolean | null {
  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => null,
  );
}
