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
      ],
      include: [
        'src/**/*.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      thresholds: {
        branches: 65,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    // Fresh-schema suites create the same PostgreSQL extensions. PostgreSQL's
    // CREATE EXTENSION IF NOT EXISTS is not race-safe across sessions.
    fileParallelism: !process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL,
    globals: true,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
