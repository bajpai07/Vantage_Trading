export const MAX_BACKOFF_MS = 60_000;

/** The wait before the next refresh: pollMs after a success, doubling with each consecutive failure up to a minute. */
export function nextDelayMs(pollMs: number, failures: number): number {
  let d = pollMs;
  for (let i = 0; i < failures && d < MAX_BACKOFF_MS; i += 1) d *= 2;
  return d > MAX_BACKOFF_MS ? MAX_BACKOFF_MS : d;
}
