/* eslint-disable @typescript-eslint/no-require-imports */
process.env.TZ = 'UTC';
const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

// Flow tests drive a RUNNING dev server over HTTP — no app imports, no DB, no
// mocks. They deliberately skip jest.setup.js, which polyfills fetch with
// cross-fetch (no getSetCookie) and mocks prisma/next-auth for in-process unit
// tests. Native Node fetch + a plain node environment is exactly what we want.
module.exports = createJestConfig({
    testEnvironment: 'node',
    setupFilesAfterEnv: [],
    testMatch: ['<rootDir>/flow-tests/**/*.flow.test.[jt]s'],
    moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
    // The standalone build nests a package.json named "checkmein" under .next/,
    // which collides with the app's own in jest's haste map.
    modulePathIgnorePatterns: ['<rootDir>/.next/'],
    // Jest's 5000ms default is too tight here: whichever file runs FIRST pays the
    // full first-hit Turbopack compile cost for every route the journey touches
    // (~10+ sequential requests against a `next dev` server that hasn't compiled
    // any of them yet), and that cold-start tax alone can exceed 5s on a loaded CI
    // runner — timing out mid-journey, which then races the abandoned in-flight
    // request against afterAll's cleanup (e.g. #930's CI failure: a timed-out
    // membership-activation-fanout run left its Shopify webhook call racing
    // resetApplicantHousehold's DELETE, surfacing as a spurious 500). Later files
    // reuse the now-warm routes and finish in a fraction of this.
    testTimeout: 20000,
});
