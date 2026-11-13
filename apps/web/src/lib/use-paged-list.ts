'use client';
// "Load more" pagination over the API's opaque cursors. The first page comes from the server render; each further
// page is fetched in the browser through the same-origin proxy and validated. Rows are de-duplicated by id, so a
// retry or a double click can never show a row twice.
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ZodType } from 'zod';
import { clientGet } from './client-api';
import { describeFailure } from './errors';
import type { FailureMessage } from './errors';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function usePagedList<T extends { id: string }, R>(opts: {
  initial: Page<T>;
  /** The path without the cursor, e.g. "/v1/orders?limit=50". */
  path: string;
  schema: ZodType<R>;
  pick: (response: R) => Page<T>;
}) {
  const router = useRouter();
  const { path, schema, pick } = opts;
  const [items, setItems] = useState<readonly T[]>(opts.initial.items);
  const [cursor, setCursor] = useState<string | null>(opts.initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FailureMessage | null>(null);

  const loadMore = useCallback(async (): Promise<void> => {
    if (cursor === null || loading) return;
    setLoading(true);
    setError(null);
    const sep = path.includes('?') ? '&' : '?';
    const r = await clientGet(`${path}${sep}cursor=${encodeURIComponent(cursor)}`, schema);
    setLoading(false);
    if (!r.ok) {
      if (r.kind === 'unauthenticated') {
        router.replace('/login?reason=expired');
        router.refresh();
        return;
      }
      setError(describeFailure(r, 'load'));
      return;
    }
    const page = pick(r.data);
    setItems((prev) => {
      const seen = new Set(prev.map((x) => x.id));
      return [...prev, ...page.items.filter((x) => !seen.has(x.id))];
    });
    setCursor(page.nextCursor);
  }, [cursor, loading, path, schema, pick, router]);

  return { items, hasMore: cursor !== null, loading, error, loadMore };
}
