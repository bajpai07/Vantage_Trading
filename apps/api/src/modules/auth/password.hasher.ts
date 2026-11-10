import { hash, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

// Algorithm is a const enum in the library's typings, which verbatimModuleSyntax cannot import; 2 is Argon2id
// (a test asserts the encoded hash starts with $argon2id$).
const ARGON2ID = 2 as Algorithm;

/** Argon2id parameters, in one place (OWASP minimum: 19 MiB memory, 2 iterations, 1 lane). */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export interface PasswordHasher {
  /** Returns the encoded string, e.g. $argon2id$v=19$m=19456,t=2,p=1$... */
  hash(password: string): Promise<string>;
  /** True when the password matches. Never throws for a malformed hash: that is simply false. */
  verify(encodedHash: string, password: string): Promise<boolean>;
}

export const argon2Hasher: PasswordHasher = {
  hash: (password) => hash(password, ARGON2_PARAMS),
  verify: async (encodedHash, password) => {
    try {
      return await verify(encodedHash, password);
    } catch {
      return false;
    }
  },
};
