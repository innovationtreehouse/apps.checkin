/* eslint-disable @typescript-eslint/no-require-imports */
process.env.TZ = 'UTC';
const nextJest = require('next/jest')

const createJestConfig = nextJest({
    // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
    dir: './',
})

// Add any custom config to be passed to Jest
// Integration tests (*.integration.test.ts) talk to a real Postgres and are
// excluded from the default run so `npm run test:ci` works without a DB.
// Run them with `npm run test:integration` against a live database.
const customJestConfig = {
    // 'default' keeps jest's built-in output; ours appends a loud summary of
    // tests that failed by THROWING (schema/mock rot) vs honest assertions.
    // jest-junit only runs in CI (gated on process.env.CI) so local dev runs
    // don't litter the working tree with test-results/junit.xml on every run;
    // ci.yml feeds that file to dorny/test-reporter to publish a Check Run.
    reporters: [
        'default',
        '<rootDir>/test/failureClassifierReporter.js',
        ...(process.env.CI
            ? [['jest-junit', {
                outputDirectory: 'test-results',
                outputName: 'junit.xml',
                suiteNameTemplate: '{filepath}',
                classNameTemplate: '{classname}',
                titleTemplate: '{title}',
            }]]
            : []),
    ],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    // Coverage (only collected when a run passes --coverage; normal runs are
    // unaffected). v8 provider because next/jest transforms with SWC, not babel,
    // so babel-plugin-istanbul never instruments — v8 reads Node's own coverage.
    coverageProvider: 'v8',
    coverageDirectory: 'coverage',
    // 'json' (coverage-final.json) is consumed by `nyc merge` in ci.yml's
    // coverage-gate job, which merges the unit + integration tiers before
    // checking coverageThreshold below.
    coverageReporters: ['text-summary', 'lcov', 'json-summary', 'json'],
    // Explicit path (not the OS tmp default) so ci.yml can cache it across runs.
    cacheDirectory: '<rootDir>/.jest-cache',
    // Hard gate, but only meaningful against the FULL suite's coverage (unit ∪
    // integration — see collectCoverageFrom below). ci.yml now runs those tiers
    // as separate jobs, each a partial suite that would trip these floors on its
    // own, so each sets SKIP_COVERAGE_THRESHOLD and the merged coverage-gate job
    // enforces this same threshold against the merged report instead. Local
    // `npm run test:coverage` leaves the env unset, so it still enforces here.
    ...(process.env.SKIP_COVERAGE_THRESHOLD ? {} : {
        coverageThreshold: {
            global: {
                lines: 85,
                branches: 75,
                functions: 75,
            },
        },
    }),
    // Count every source file, so untested files show as 0% rather than vanishing.
    collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/**/__tests__/**',
        '!src/**/__mocks__/**',
        '!src/**/*.test.{ts,tsx}',
        '!src/generated/**',          // generated Prisma client
        '!src/security/generated/**', // generated classification mirror
        '!src/types/**',              // type-only declarations
        '!src/test-helpers/**',
    ],
    // Integration tier only (gated by INTEGRATION_DB): clone one Postgres DB per
    // worker so parallel workers can't corrupt each other. No-op for `test:ci`.
    globalSetup: '<rootDir>/test/integrationGlobalSetup.js',
    globalTeardown: '<rootDir>/test/integrationGlobalTeardown.js',
    testEnvironment: 'jest-environment-jsdom',
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        // Workspace TS package — point jest at its source so it transforms it.
        '^@inventory/money$': '<rootDir>/../packages/money/src/index.ts',
    },
    // The worktree ignore lives at the repo root (.claude/worktrees/), one level
    // up now that rootDir is checkin-app/. testPathIgnorePatterns matches the
    // absolute path, so the bare substring still works; modulePathIgnorePatterns
    // is <rootDir>-anchored and must reach up to the repo root.
    testPathIgnorePatterns: [
        '/node_modules/',
        // Stop the PRIMARY checkout's jest from descending into sibling worktree
        // dirs. But when jest itself runs FROM inside a worktree, every test path
        // contains /.claude/worktrees/ -> this ignore matches ALL of them ->
        // "No tests found" -> exit 1 -> the pre-commit hook false-blocks every
        // worktree commit. So only apply the ignore when our own cwd is NOT in a
        // worktree; from within a worktree, rootDir already scopes collection to
        // this worktree's own tests, so dropping the pattern is safe.
        // (Detect via cwd, not an env flag: core.hooksPath points at the PRIMARY
        // checkout's .husky, so a worktree commit runs main's pre-commit — a
        // hook-exported flag wouldn't reach here until merged+deployed to main.)
        ...(process.cwd().includes('/.claude/worktrees/') ? [] : ['/.claude/worktrees/']),
        '\\.integration\\.test\\.[jt]sx?$',
        // Flow tests drive a running dev server over HTTP — excluded from the
        // default/unit run; run with `npm run test:flow` (see AGENTS.md).
        '\\.flow\\.test\\.[jt]sx?$',
        // (Shopify LIVE tests need no entry here: they are *.shopify-live.ts —
        // no .test suffix — so no default testMatch or CLI-overridden ignore
        // list can ever pick them up. See jest.shopify-live.config.js.)
    ],
    modulePathIgnorePatterns: [
        '<rootDir>/../.claude/worktrees/',
        // The standalone build nests a package.json named "checkmein" under
        // .next/, which collides with the app's own in jest's haste map.
        '<rootDir>/.next/',
    ],
}

module.exports = async () => {
    const jestConfig = await createJestConfig(customJestConfig)();
    
    // next/jest ignores node_modules by default, but @auth/prisma-adapter is ESM,
    // and the prisma-client generator's runtime dynamically imports ESM/WASM files
    // from @prisma/client (e.g. query_compiler_fast_bg.postgresql.mjs) that Jest
    // must transform rather than parse as CommonJS.
    jestConfig.transformIgnorePatterns = [
        '/node_modules/(?!(@auth/prisma-adapter|@prisma/client)/)'
    ];

    return jestConfig;
}

// Exposed for the runner-boundary guard (src/__tests__/workspaceRunnerIsolation.test.ts):
// the default export runs next/jest, which throws when invoked inside a jest worker,
// so the guard inspects this raw object's rootDir/roots instead.
module.exports.customJestConfig = customJestConfig;
