import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'dist/**',
        'src/db/migrate.ts',
        'src/dev/**',
        'src/embeddings/**',
        'src/index.ts',
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
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
