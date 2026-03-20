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
        'src/mcp.ts',
        'src/server.ts',
        'src/testing/**',
        'src/tools/databases.ts',
        'src/tools/links.ts',
        'src/tools/pages.ts',
        'src/tools/rows.ts',
        'src/tools/search.ts',
        'src/tools/workspaces.ts',
      ],
      include: [
        'src/db/access.ts',
        'src/tools/common.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      thresholds: {
        branches: 80,
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
