import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'dist/**',
        'src/launcher.ts',
        'src/mcp.ts',
        'src/testing/**',
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'dashboard/src/**/*.test.ts',
        'dashboard/src/**/*.test.tsx',
        'dashboard/src/**/*.d.ts',
      ],
      include: [
        'src/**/*.ts',
        'dashboard/src/**/*.ts',
        'dashboard/src/**/*.tsx',
      ],
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    // Fresh-schema suites create the same PostgreSQL extensions. PostgreSQL's
    // CREATE EXTENSION IF NOT EXISTS is not race-safe across sessions.
    fileParallelism: !process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL,
    globals: true,
    include: [
      'dashboard/src/**/*.test.ts',
      'dashboard/src/**/*.test.tsx',
      'src/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
  },
});
