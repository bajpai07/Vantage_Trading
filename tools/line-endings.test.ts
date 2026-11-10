import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('line endings', () => {
  it('infra/postgres/01-bootstrap.sh has no CR (it runs in a Linux container)', () => {
    const text = readFileSync(resolve(root, 'infra/postgres/01-bootstrap.sh'), 'utf8');
    expect(text.includes('\r')).toBe(false);
    expect(text.startsWith('#!/bin/bash\n')).toBe(true);
  });

  it('every db/migrations/*.sql has no CR', () => {
    const dir = resolve(root, 'db/migrations');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      expect(readFileSync(resolve(dir, f), 'utf8').includes('\r'), f).toBe(false);
    }
  });
});
