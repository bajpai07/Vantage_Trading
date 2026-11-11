import type { MeResponse } from '@vantage/contracts';
import type { UserRecord } from './users.service.js';

export const toMeResponse = (u: UserRecord): MeResponse => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  countryCode: u.countryCode,
  role: u.role as MeResponse['role'],
  status: u.status as MeResponse['status'],
});
