// Stops the API through its control port so it can drop its throwaway database (no leftover t_* databases), then
// waits for the process to go; it is killed only if it does not.
import { CONTROL_PORT } from '../playwright.config';

export default async function globalTeardown(): Promise<void> {
  const child = (globalThis as { __e2eApi?: { exitCode: number | null; kill(): boolean } })
    .__e2eApi;
  try {
    await fetch(`http://127.0.0.1:${String(CONTROL_PORT)}/shutdown`, { method: 'POST' });
  } catch {
    // already gone
  }
  const until = Date.now() + 20_000;
  while (child !== undefined && child.exitCode === null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child !== undefined && child.exitCode === null) child.kill();
}
