// Dependency-injection tokens. Every injection in this app uses an explicit @Inject(token), so nothing
// depends on emitted decorator metadata (esbuild/Vitest does not emit it).
export const CONFIG = Symbol('CONFIG');
export const CLOCK = Symbol('CLOCK');
export const LOGGER = Symbol('LOGGER');
export const POOL = Symbol('POOL');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const LOGIN_LIMITER_PAIR = Symbol('LOGIN_LIMITER_PAIR');
export const LOGIN_LIMITER_IP = Symbol('LOGIN_LIMITER_IP');
export const REGISTER_LIMITER = Symbol('REGISTER_LIMITER');

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
