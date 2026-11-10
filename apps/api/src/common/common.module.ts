import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard.js';
import { EnvelopeExceptionFilter } from './exception.filter.js';

/** Global cross-cutting providers: the CSRF origin guard and the error-envelope filter. */
@Module({
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_FILTER, useClass: EnvelopeExceptionFilter },
  ],
})
export class CommonModule {}
