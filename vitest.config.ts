import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages resolve to their TypeScript source in tests (no build needed).
const alias = [
  { find: /^@vantage\/config\/testing$/, replacement: src('./packages/config/src/testing.ts') },
  { find: /^@vantage\/config$/, replacement: src('./packages/config/src/index.ts') },
  { find: /^@vantage\/contracts$/, replacement: src('./packages/contracts/src/index.ts') },
  { find: /^@vantage\/engine$/, replacement: src('./packages/engine/src/index.ts') },
  { find: /^@vantage\/money$/, replacement: src('./packages/money/src/index.ts') },
  { find: /^@vantage\/test-utils$/, replacement: src('./packages/test-utils/src/index.ts') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages,tools}/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,packages,tools}/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // Files run one after another: the cleanup test drops every t_* database, so a parallel file would lose its own.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
