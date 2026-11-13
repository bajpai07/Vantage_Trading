// Runs in the browser before the app's own code (Next.js client instrumentation). Zod 4 otherwise probes `new Function()`
// when a schema is created, to compile faster parsers; our CSP has no 'unsafe-eval', so the browser would report that
// probe as a violation. It must be set before the contract schemas are created, so it cannot live next to the first use.
import { z } from 'zod';

z.config({ jitless: true });
