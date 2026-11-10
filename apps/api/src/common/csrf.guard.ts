import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Config } from '@vantage/config';
import { CONFIG } from '../tokens.js';
import { AppError } from './errors.js';
import type { AppRequest } from './http.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originOf(referer: string): string | undefined {
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence (with SameSite=Lax): every state-changing request must carry an Origin header, or a
 * Referer when Origin is absent, equal to WEB_ORIGIN. Anything else gets 403.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!STATE_CHANGING.has(req.method)) return true;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const presented =
      typeof origin === 'string'
        ? origin
        : typeof referer === 'string'
          ? originOf(referer)
          : undefined;
    if (presented !== this.config.webOrigin) {
      throw new AppError(403, 'CSRF_REJECTED', 'Cross-site request rejected');
    }
    return true;
  }
}
