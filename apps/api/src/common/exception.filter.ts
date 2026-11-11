import { Catch, HttpException, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorEnvelope } from '@vantage/contracts';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import { LOGGER } from '../tokens.js';
import { AppError } from './errors.js';
import type { AppRequest } from './http.js';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};
const MESSAGE_BY_STATUS: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  413: 'Request body too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
};

/** One global filter. Every error leaves as the ErrorEnvelope; no stack trace, SQL or internal text is sent. */
@Catch()
export class EnvelopeExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<AppRequest>();
    const requestId = req.requestId ?? newId();

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let headers: Readonly<Record<string, string>> = {};

    if (exception instanceof AppError) {
      ({ status, code, message, headers } = exception);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? 'HTTP_ERROR';
      message = MESSAGE_BY_STATUS[status] ?? 'Request failed';
    } else if (isBodyParserError(exception)) {
      status = exception.status;
      code = CODE_BY_STATUS[status] ?? 'BAD_REQUEST';
      message = MESSAGE_BY_STATUS[status] ?? 'Bad request';
    } else {
      // Log the class and, for database errors, the SQLSTATE only: messages can contain values.
      const e = exception as { name?: unknown; code?: unknown } | null;
      this.logger.error('unhandled_error', {
        requestId,
        errorName: typeof e?.name === 'string' ? e.name : 'unknown',
        errorCode: typeof e?.code === 'string' ? e.code : undefined,
      });
    }

    const body: ErrorEnvelope = { error: { code, message, requestId } };
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json(body);
  }
}

function isBodyParserError(e: unknown): e is { status: number } {
  if (typeof e !== 'object' || e === null) return false;
  const x = e as { status?: unknown; type?: unknown };
  return (
    typeof x.status === 'number' && x.status >= 400 && x.status < 500 && typeof x.type === 'string'
  );
}
