// The loading, load-error and error-boundary states of the private pages (M6a acceptance 10, tested in M6b T5).
import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { networkFailure } from '../lib/api-core';
import type { ApiFailure } from '../lib/api-core';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/portfolio',
}));

import Loading from '../app/(app)/loading';
import PrivateError from '../app/(app)/error';
import { LoadError } from './load-error';

/** Finds the first element of the given type in a React element tree without rendering it. */
function findButton(node: ReactNode): ReactElement<{ onClick?: () => void }> | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.type === 'button') return el;
  const kids = el.props.children;
  for (const k of Array.isArray(kids) ? (kids as ReactNode[]) : [kids]) {
    const f = findButton(k);
    if (f !== null) return f;
  }
  return null;
}

describe('loading state', () => {
  it('is an announced, busy status with placeholder rows and a text label, and shows no data', () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading your data');
    expect(html).toContain('data-testid="loading"');
    expect(html).not.toMatch(/\d,\d{3}\.\d{2}/); // no figures: nothing here pretends to be data
  });

  it('respects reduced motion: the pulse only applies under motion-safe', () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('motion-safe:animate-pulse');
    expect(html).not.toMatch(/(^|[\s"])animate-pulse/);
  });
});

describe('load error (the server could not fetch the page data)', () => {
  const failure = (over: Partial<ApiFailure>): ApiFailure => ({ ...networkFailure(), ...over });

  it('says what happened in a sentence, shows the support code, never a stack or raw JSON', () => {
    const html = renderToStaticMarkup(
      <LoadError
        failure={failure({ kind: 'server', status: 500, supportCode: 'req-abc123' })}
        what="Portfolio"
      />,
    );
    expect(html).toContain('data-testid="load-error"');
    expect(html).toContain('Portfolio');
    expect(html).toContain('req-abc123');
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/\{|stack|TypeError|at \w+\s*\(/);
  });

  it('a network failure is worded as one (not as "no data")', () => {
    const html = renderToStaticMarkup(<LoadError failure={networkFailure()} what="Orders" />);
    expect(html).toContain('can&#x27;t reach the server');
    expect(html).not.toContain('No orders');
  });

  it('"Try again" re-asks the server (router.refresh) and does nothing else', () => {
    refresh.mockClear();
    const tree = LoadError({ failure: networkFailure(), what: 'Orders' });
    const button = findButton(tree);
    expect(button).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    button?.props.onClick?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('error boundary of the private pages', () => {
  it('shows a plain sentence and only the digest as a support code', () => {
    const err = Object.assign(new Error('secret internal detail: SELECT * FROM users'), {
      digest: 'D1G3ST',
    });
    const html = renderToStaticMarkup(<PrivateError error={err} reset={() => undefined} />);
    expect(html).toContain('data-testid="page-error"');
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Support code: D1G3ST');
    expect(html).toContain('Your money and orders are not affected');
    expect(html).not.toContain('secret internal detail');
    expect(html).not.toContain('SELECT');
  });

  it('without a digest there is no support line, and "Try again" calls reset', () => {
    const reset = vi.fn();
    const err = new Error('boom');
    const html = renderToStaticMarkup(<PrivateError error={err} reset={reset} />);
    expect(html).not.toContain('Support code');
    expect(html).not.toContain('boom');
    const button = findButton(PrivateError({ error: err, reset }));
    button?.props.onClick?.();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
