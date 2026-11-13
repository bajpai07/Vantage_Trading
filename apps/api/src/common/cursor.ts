// Opaque keyset cursor shared by the paginated endpoints: a position (timestamp text with microseconds, id).
// The cursor only names a position inside the caller's own, already scoped result set, so a tampered or foreign
// cursor can never reach another user's rows.
import { AppError } from './errors.js';

export interface CursorPayload {
  readonly t: string;
  readonly id: string;
}
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL fragment that renders a timestamptz column as the cursor time text, e.g. cursorTimeSql('o.created_at'). */
export const cursorTimeSql = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const encodeCursor = (p: CursorPayload): string =>
  Buffer.from(JSON.stringify([p.t, p.id]), 'utf8').toString('base64url');

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2) {
      const [t, id] = v as unknown[];
      if (typeof t === 'string' && typeof id === 'string' && CURSOR_TIME.test(t) && UUID.test(id)) {
        return { t, id };
      }
    }
  } catch {
    // fall through
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request: cursor');
}
