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

// Determinism guard for time-handling pure code (market-model): the same bans as the money guard (no
// clock, no randomness, no IO, no float literals, no parseFloat), except that integer parsing with
// parseInt(x, 10) and the integer-safe Math members floor/trunc/abs/min/max are allowed, because calendar
// code must read and divide integers. Prices are never parsed here: they are strings handled by @vantage/money.
const RELAXED_FOR_TIME = new Set([
  "CallExpression[callee.name='parseInt']",
  "MemberExpression[object.name='Math']",
]);
export const determinismGuardRules = {
  'no-restricted-syntax': [
    'error',
    ...moneyGuardRules['no-restricted-syntax']
      .slice(1)
      .filter((r) => !RELAXED_FOR_TIME.has(r.selector)),
    {
      selector:
        "MemberExpression[object.name='Math'][property.name=/^(?!(floor|trunc|abs|min|max)$)/]",
      message:
        'market-model: only Math.floor/trunc/abs/min/max are allowed (no Math.random, no float math)',
    },
  ],
  'no-restricted-imports': moneyGuardRules['no-restricted-imports'],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    // The API logs through log.ts only (no console), so nothing can print a request body by accident.
    files: ['apps/api/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // Module boundaries: a module reaches the ledger only through LedgerService, never its repository files.
    files: ['apps/api/src/modules/{auth,users,accounts,audit,health,db,config}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/ledger/repository*',
                '**/ledger/reconcile*',
                '**/ledger/errors*',
                '**/ledger/index*',
              ],
              message:
                'import LedgerService from ledger.service.js instead of reaching into the repository',
            },
          ],
        },
      ],
    },
  },
  {
    // The web app runs in the browser and on the Next server. Raw hex colours live in tokens.css only (DESIGN_SYSTEM
    // section 10): components use token classes and variables.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'apps/web/e2e/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'web: no raw hex colours (use the design tokens in src/styles/tokens.css)',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'web: no raw hex colours (use the design tokens in src/styles/tokens.css)',
        },
      ],
    },
  },
  {
    // Money is shown exactly as the API sent it: no number conversion and no arithmetic in the display helpers.
    files: [
      'apps/web/src/lib/money.ts',
      'apps/web/src/lib/format.ts',
      'apps/web/src/lib/ticket.ts',
      'apps/web/src/lib/change.ts',
      'apps/web/src/components/change-cell.tsx',
      'apps/web/src/components/order-ticket.tsx',
      'apps/web/src/lib/orders-view.ts',
      'apps/web/src/components/orders-list.tsx',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'web money: parseFloat is banned',
        },
        {
          selector: "CallExpression[callee.name='parseInt']",
          message: 'web money: parseInt is banned',
        },
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'web money: Number(...) is banned',
        },
        {
          selector: "MemberExpression[object.name='Math']",
          message: 'web money: Math.* is banned',
        },
        {
          selector: 'Literal[value=type(number)][raw=/[.eE]/]',
          message: 'web money: decimal or exponent literals are banned',
        },
        {
          selector: "UnaryExpression[operator='+']",
          message: 'web money: unary + (number conversion) is banned',
        },
      ],
    },
  },
  {
    files: ['packages/money/src/**/*.ts', 'packages/engine/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: moneyGuardRules,
  },
  {
    files: ['packages/market-model/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: determinismGuardRules,
  },
);
