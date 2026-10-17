/* eslint-disable @typescript-eslint/no-require-imports */
const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

// LIVE Shopify contract suite (docs/ops/shopify-live-tests.md): drives the
// real lib/shopify.ts functions against the REAL dev store. Excluded from the
// unit/CI/pre-commit runs (see testPathIgnorePatterns in jest.config.js); run
// via `npm run test:shopify-live` where dev-store credentials are provisioned
// (.github/workflows/shopify-live.yml). Serialized (maxWorkers 1) to respect
// the Admin API rate budget; generous timeout — each test is several real
// network round trips.
module.exports = createJestConfig({
    testEnvironment: 'node',
    // Deliberately skips jest.setup.js: that file mocks prisma/next-auth and
    // polyfills fetch for in-process unit tests — the live suite wants native
    // fetch and mocks only what it declares (same convention as flow tests).
    setupFilesAfterEnv: [],
    // Deliberately NOT *.test.ts: the default jest testMatch (and any script
    // that overrides testPathIgnorePatterns on the CLI, e.g. test:coverage)
    // matches every *.test.ts under rootDir — the .test-free suffix makes the
    // live suite structurally invisible to every other jest invocation.
    testMatch: ['<rootDir>/shopify-live/**/*.shopify-live.[jt]s'],
    moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
    modulePathIgnorePatterns: ['<rootDir>/.next/'],
    maxWorkers: 1,
    testTimeout: 90_000,
});
