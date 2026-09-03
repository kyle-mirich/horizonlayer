import { defineConfig } from 'vitest/config';

// Narrow Vitest config for StrykerJS mutation runs. The main
// `vitest.config.ts` covers the whole repo (including jsdom dashboard
// suites); running all of that per mutant would be prohibitively slow.
// This config runs only the unit tests covering the modules in
// `stryker.config.mjs`, keeping `npm run test:mutation` local-only and fast.
export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    include: [
      'src/references.test.ts',
      'src/tools/common.test.ts',
      'src/tools/issueQuery.test.ts',
      'src/tools/searchFormat.test.ts',
    ],
    isolate: true,
    setupFiles: ['./vitest.setup.ts'],
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
