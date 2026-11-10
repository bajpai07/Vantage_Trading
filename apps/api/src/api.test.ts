import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTestEnv } from '@vantage/config/testing';
import { describe, expect, it } from 'vitest';
import { run } from './run.js';

function capture(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('api run()', () => {
  it('--check with valid env exits 0 and prints config_ok', () => {
    const r = capture(['--check'], buildTestEnv());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ app: 'api', status: 'config_ok' });
  });
  it('--check with empty env exits 2 with the error on stderr', () => {
    const r = capture(['--check'], {});
    expect(r.code).toBe(2);
    expect(r.err).toContain('APP_ENV');
    expect(r.err).toContain('WEB_ORIGIN');
    expect(r.out).toBe('');
  });
  it('an unknown argument exits 64', () => {
    expect(capture(['--bogus'], buildTestEnv()).code).toBe(64);
    expect(capture(['--check', 'extra'], buildTestEnv()).code).toBe(64);
  });
  it('no arguments means "start the server"', () => {
    expect(capture([], buildTestEnv()).code).toBe('start');
  });
});

// A real child process with a replaced environment: no env file, no DB, no network.
describe('api entry as a script', () => {
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  const spawn = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', main, ...args], {
      env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
      encoding: 'utf8',
    });
  it('--check exits 2 with an empty environment', () => {
    const r = spawn(['--check'], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('APP_ENV');
  });
  it('--check exits 0 with a valid environment (no database needed), unknown flag exits 64', () => {
    const env = buildTestEnv() as Record<string, string>;
    expect(spawn(['--check'], env).status).toBe(0);
    expect(spawn(['--bogus'], env).status).toBe(64);
  });
  it('starting with an empty environment exits 2 instead of serving', () => {
    expect(spawn([], {}).status).toBe(2);
  });
});
