import { z } from 'zod';

/** Canonical decimal string: at least two decimal places, e.g. "10000.00" or "-49.6000". */
export const MoneyString = z
  .string()
  .regex(/^-?\d+\.\d{2,}$/, 'must be a canonical decimal string');
