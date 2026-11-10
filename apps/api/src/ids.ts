import { v7 } from 'uuid';

/** D-41: every new id is a UUIDv7 generated here, in one place. money and engine never generate ids. */
export function newId(): string {
  return v7();
}
