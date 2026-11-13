import { FeedInfoResponse } from '@vantage/contracts';
import { getWebConfig } from './config';

/**
 * The active market data source, asked of the API on the server for every render (no caching). Returns null when the
 * API cannot be asked or answers with something unexpected: the banner then says the status is unknown.
 */
export async function getFeedInfo(): Promise<FeedInfoResponse | null> {
  try {
    const res = await fetch(`${getWebConfig().apiBaseUrl}/v1/market/feed`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const parsed = FeedInfoResponse.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
