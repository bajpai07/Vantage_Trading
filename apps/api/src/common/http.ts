import type { Request, Response } from 'express';
import type { Logger } from '../log.js';

export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly status: string;
}

export interface AppRequest extends Request {
  requestId: string;
  auth?: AuthContext;
}

export const SESSION_COOKIE = 'vantage_session';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Reuses the incoming id only when it is a short, boring string; otherwise the caller generates one. */
export function safeRequestId(incoming: unknown): string | undefined {
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : undefined;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

export function sessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${String(opts.maxAgeSeconds)}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The peer address of the socket. X-Forwarded-For is NOT trusted (no trusted-proxy setting exists yet). */
export function clientIp(req: Request): string | undefined {
  return req.socket.remoteAddress;
}

export function requestLogger(logger: Logger) {
  return (req: Request, res: Response, next: () => void): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1000n);
      logger.info('request', {
        requestId: (req as AppRequest).requestId,
        method: req.method,
        // the path only: never the query string, headers, cookies or body
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: ms / 1000,
      });
    });
    next();
  };
}
