import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const num = (re) => `Literal[value=type(number)][raw=/${re}/]`;

// Money guard: applied to packages/money/src (and later packages/engine/src), tests excluded.
export const moneyGuardRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.name='parseFloat']",
      message: 'money: parseFloat is banned',
    },
    { selector: "CallExpression[callee.name='parseInt']", message: 'money: parseInt is banned' },
    { selector: "CallExpression[callee.name='Number']", message: 'money: Number(...) is banned' },
    {
      selector: "NewExpression[callee.name='Number']",
      message: 'money: new Number(...) is banned',
    },
    {
      selector: "MemberExpression[object.name='Number'][property.name=/^parse(Float|Int)$/]",
      message: 'money: Number.parse* is banned',
    },
    { selector: "MemberExpression[object.name='Math']", message: 'money: Math.* is banned' },
    {
      selector: num('^(?!0[xXbBoO]).*[.eE]'),
      message:
        'money: decimal or exponent number literals are banned (hex and integers are allowed)',
    },
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: 'money: Date.now is banned',
    },
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'money: new Date() with no argument is banned',
    },
    { selector: "CallExpression[callee.name='Date']", message: 'money: Date() is banned' },
    {
      selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
      message: 'money: performance.now is banned',
    },
  ],
  // No IO, no clocks: only pure code may live here (money and engine).
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...[
          'perf_hooks',
          'fs',
          'fs/promises',
          'path',
          'crypto',
          'http',
          'https',
          'http2',
          'net',
          'tls',
          'dns',
          'dgram',
          'os',
          'child_process',
          'worker_threads',
          'cluster',
          'stream',
          'zlib',
          'readline',
          'vm',
          'timers',
          'timers/promises',
          'pg',
        ].map((name) => ({ name, message: 'money/engine must stay pure: no IO or clock imports' })),
      ],
      patterns: [
        { group: ['node:*', 'pg-*', '@vantage/api*'], message: 'money/engine must stay pure' },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    files: ['packages/money/src/**/*.ts', 'packages/engine/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: moneyGuardRules,
  },
);
