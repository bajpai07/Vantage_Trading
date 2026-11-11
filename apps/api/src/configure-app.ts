import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '@vantage/config';
import { requestLogger, safeRequestId } from './common/http.js';
import type { AppRequest } from './common/http.js';
import { newId } from './ids.js';
import type { Logger } from './log.js';

/** Cross-cutting HTTP setup shared by the real server and the tests. */
export function configureApp(app: NestExpressApplication, config: Config, logger: Logger): void {
  app.disable('x-powered-by');

  // Request id: reuse the incoming x-request-id only if it matches a safe pattern.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = safeRequestId(req.headers['x-request-id']) ?? newId();
    (req as AppRequest).requestId = id;
    res.setHeader('x-request-id', id);
    next();
  });

  // Basic security headers. The API serves JSON only.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(requestLogger(logger));

  // CORS only for the one configured origin, with credentials.
  app.enableCors({
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id'],
  });

  // JSON bodies are capped at 100 KB.
  app.useBodyParser('json', { limit: '100kb' });
}
