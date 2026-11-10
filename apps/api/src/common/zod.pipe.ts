import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from './errors.js';

/** Validates a request body with a Zod schema. The error names the bad fields, never their values. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const fields = [
      ...new Set(result.error.issues.map((i) => i.path.map(String).join('.') || 'body')),
    ];
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid request: ${fields.join(', ')}`);
  }
}
