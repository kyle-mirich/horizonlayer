/**
 * StrykerJS mutation testing configuration.
 *
 * Focused initial scope: small, pure, fast server modules with strong unit
 * coverage. These files have no Docker, PostgreSQL, Qdrant, or browser
 * dependencies, so a mutation run stays local-only and finishes quickly.
 * Widen `mutate` once the baseline is green.
 *
 * Run locally with `npm run test:mutation`. CI runs the same command as a
 * non-blocking reporter (see `.github/workflows/ci.yml`).
 *
 * To opt into type-aware mutant filtering, install
 * `@stryker-mutator/typescript-checker` and set `checkers: ['typescript']`.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  $schema: 'https://stryker-mutator.io/schema/stryker-core.json',
  checkers: [],
  cleanTempDir: true,
  concurrency: 4,
  // NOTE: do not exclude `src/**/*.test.ts` here. `ignorePatterns` keeps
  // files out of the Stryker sandbox entirely, which would leave Vitest
  // with no tests to run. Test files are already protected from mutation
  // because `mutate` below lists only source files.
  ignorePatterns: [
    '.agents/**',
    '.claude-plugin/**',
    '.git/**',
    '.opencode/**',
    '.stryker-tmp/**',
    'dashboard/**',
    'dist/**',
    'docs/**',
    'node_modules/**',
    'reports/**',
  ],
  mutate: [
    'src/references.ts',
    'src/tools/common.ts',
    'src/tools/issueQuery.ts',
    'src/tools/searchFormat.ts',
  ],
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['clear-text', 'progress', 'html'],
  tempDirName: '.stryker-tmp',
  testRunner: 'vitest',
  thresholds: { break: null, high: 80, low: 60 },
  timeoutFactor: 1.5,
  timeoutMS: 15000,
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
};
