/* eslint-disable @typescript-eslint/no-require-imports */
import '@testing-library/jest-dom'
import failOnConsole from 'jest-fail-on-console'

// Integration tier (A+B): point THIS worker at its own cloned database before
// any test module loads @/lib/prisma. integrationGlobalSetup.js created one DB
// per worker, namespaced by run id + worker id; here we just select ours. No-op
// for unit runs (INTEGRATION_DB unset).
if (process.env.INTEGRATION_DB && process.env.TEST_BASE_URL && process.env.TEST_RUN_ID) {
  const u = new URL(process.env.TEST_BASE_URL);
  u.pathname = `/checkin_test_${process.env.TEST_RUN_ID}_${process.env.JEST_WORKER_ID || '1'}`;
  process.env.DATABASE_URL = u.toString();

  // Each integration file builds its own prisma pool (fresh module registry per
  // file). Close it when the file finishes, or pools accumulate across the
  // worker's files and exhaust the shared Postgres server's max_connections.
  // disposeExternalPool (set in prisma.ts under test) makes $disconnect actually
  // end the pg pool.
  afterAll(async () => {
    try {
      await require('@/lib/prisma').default.$disconnect();
    } catch {
      // No prisma loaded in this file, or already disconnected — nothing to free.
    }
  });
}

// Tests run as a non-production environment. Previously this was implicit via
// NODE_ENV=test; under the single CHECKIN_ENV flag we declare it explicitly so
// prod-only gates (e.g. the scan self-check-in block) stay off during tests.
// 'dev' (not 'local') reproduces the old behavior exactly: it disables the
// prod-only gates while leaving the keyless-kiosk fallback and offline
// credential login (both local-only) off, just as NODE_ENV=test did.
process.env.CHECKIN_ENV = 'dev';

// The scan concurrency suite must exercise the advisory lock, not the
// single-connection serialization that a pool of 1 gives for free. Give just
// that suite a pool of 2 so its two scan transactions run on separate
// connections — then the per-participant advisory lock is the only thing that
// serializes them (as in production), and dropping the lock makes the suite
// fail. testPath is populated before setup runs (the prisma mock below relies
// on it too); @/lib/prisma reads TEST_DB_POOL_MAX when it first loads.
{
  const { testPath } = expect.getState();
  // Same reasoning for the program-capacity concurrency suites: they need a
  // pool of >= 2 so their two enroll transactions run on separate connections,
  // making the program-row FOR UPDATE lock (not pool-1 serialization) the thing
  // that serializes them — matching production.
  // mintId is the same shape again: its two mints must run on separate
  // connections so the IdCounter row lock is what serializes them.
  if (testPath && /(scanConcurrency|attendanceManualConcurrency|attendanceManualCheckinConcurrency|visitWriteLockConcurrency|programsParticipantsConcurrency|programsPublicRegisterConcurrency|trustedAdultConcurrency|householdLeadsConcurrency|mintId|facilityCloseLock)\.integration\.test\.[jt]sx?$/.test(testPath)) {
    process.env.TEST_DB_POOL_MAX = '2';
  }
}

// Polyfill text encoding
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
const fetch = require('cross-fetch');
const { Request, Response, Headers } = fetch;

// Polyfill Request and Response for Next.js API routes
global.Request = Request;
global.Response = Response;
global.Headers = Headers;
global.fetch = fetch;

// Mock NextResponse since cross-fetch Response doesn't have .json() static method
jest.mock('next/server', () => {
  return {
    NextResponse: {
      json: (body, init) => {
        return new Response(JSON.stringify(body), {
          ...init,
          headers: {
            'content-type': 'application/json',
            ...(init?.headers || {}),
          },
        });
      },
    },
  };
});

// Mock next-auth to prevent instantiation errors in App Router imports
jest.mock('next-auth', () => {
  const mockNextAuth = jest.fn(() => ({}));
  return {
    __esModule: true,
    default: mockNextAuth,
    getServerSession: jest.fn(() => Promise.resolve(null)),
  };
});

// Mock next-auth/next (used by auth.ts authenticateRequest)
jest.mock('next-auth/next', () => ({
  getServerSession: jest.fn(() => Promise.resolve(null)),
}));

// Mock auth-options to prevent cascading ESM imports
// (GoogleProvider → openid-client → jose uses ESM exports that Jest can't handle)
jest.mock('@/lib/auth-options', () => ({
  authOptions: {},
}));

// Default safety net for `@/lib/prisma`: in unit tests we should never hit a
// real database. Suites that legitimately need DB behavior live in
// *.integration.test.ts (excluded from `npm run test:ci`). Suites that need
// fine-grained Prisma mocks should `jest.mock('@/lib/prisma', ...)` themselves;
// that per-file mock will override this default. Tests that monkey-patch
// methods on the default mock (e.g. `prisma.event.findMany = jest.fn()`) work
// because each model is a real object that accepts assignment.
jest.mock('@/lib/prisma', () => {
  // Integration tests (*.integration.test.ts via `npm run test:integration`)
  // talk to the real database — give them the real client.
  const { testPath } = expect.getState();
  if (testPath && /\.integration\.test\.[jt]sx?$/.test(testPath)) {
    return jest.requireActual('@/lib/prisma');
  }
  const rejectFn = () => () => Promise.reject(new Error(
    'Unit tests must not call the real Prisma client. ' +
    "Either jest.mock('@/lib/prisma', ...) in this test, " +
    'or rename the file to *.integration.test.ts and run `npm run test:integration`.'
  ));
  // The ONE raw query a unit-tier route can legitimately reach: mintPersonId
  // (lib/person/mintId.ts) runs inside the same transaction as every
  // person.create, so any suite driving a person-creating route hits it. Match
  // the statement, hand back an id well above any fixture's, and increment so a
  // multi-create flow gets distinct ones. Every OTHER raw query still rejects —
  // "unit tests must not call the real client" is the point of this mock.
  let nextMintedId = 100000;
  const queryRaw = (strings, ...values) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (sql.includes('IdCounter')) return Promise.resolve([{ value: nextMintedId++ }]);
    return rejectFn()(strings, ...values);
  };
  // Advisory locks are a DB-only concern — a no-op under the unit mock, same
  // narrow-carve-out pattern as the IdCounter mint above.
  const executeRaw = (strings, ...values) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve(0);
    return rejectFn()(strings, ...values);
  };
  const models = new Map();
  const handler = {
    get(_target, prop) {
      if (prop === '$queryRaw') return queryRaw;
      if (prop === '$executeRaw') return executeRaw;
      if (!models.has(prop)) {
        // Each method access on an unset key returns a rejecting function so
        // accidental calls fail loudly; explicit assignment overrides it.
        models.set(prop, new Proxy({}, {
          get(modelTarget, methodProp) {
            if (methodProp in modelTarget) return modelTarget[methodProp];
            return rejectFn();
          },
        }));
      }
      return models.get(prop);
    },
  };
  return {
    __esModule: true,
    default: new Proxy({}, handler),
  };
});

// ---------------------------------------------------------------------------
// Fail any test that logs an UNEXPECTED console.error.
//
// Jest only fails on a failed assertion or an uncaught throw, so before this a
// new error could stack-trace into the log and every check still passed green.
// jest-fail-on-console flips that: an unallowlisted console.error throws and
// turns the test red. Runs for BOTH tiers (setupFilesAfterEnv covers unit and
// integration).
//
// KNOWN_INTENTIONAL is the allowlist: console.error messages that fire on
// purpose — catch-block/service logs whose negative path a test deliberately
// exercises while asserting only the HTTP status/DB outcome, plus React/jsdom
// test-env noise. Each entry is anchored to the log's FIXED prefix (not `.*`)
// so a genuinely new, different error still slips past and fails the test.
//
// Rules for adding an entry:
//   1. Only incidental logs — the error is a side effect of the path under
//      test, NOT the thing the test is checking.
//   2. Match a stable, specific prefix. Never a broad `.*` that would swallow
//      unrelated future errors.
//   3. If a flagged error is actually a REAL bug (something logging where it
//      shouldn't), FIX it — do not allowlist it. (The runPaced mock-drift found
//      while building this list was fixed, not allowlisted.)
// The 9 suites that jest.spyOn(console,...) still suppress their own messages
// before they reach this guard — left as-is on purpose.
const KNOWN_INTENTIONAL = [
  // React / jsdom test-environment noise (emitted via console.error).
  /Not implemented: navigation/,          // jsdom: window.location navigation
  /not wrapped in act\(/,                  // React state update outside act()
  /In HTML, .+ cannot be a (child|descendant) of/, // React DOM-nesting validation
  /cannot contain a nested/,               // React DOM-nesting validation (alt phrasing)
  // Bracketed service log namespaces (incidental negative-path logs).
  /^\[Shopify/,                            // [Shopify], [Shopify Error], [Shopify API Error]
  /^\[s-read diagnose\]/,                  // shopify-read diagnostics probes
  /^\[enroll\]/,                           // program enroll compensation logs
  /^\[CRON\]/,                             // cron job per-item failure logs
  // Prefixed catch-block/service logs (incidental negative-path logs).
  /^Failed to fetch household:/,
  /^Failed to fetch attendance:/,
  /^Search error:/,
  /^resolveHouseholdRecipients failed:/,
  /^Renewal begin error:/,
  /^Match audit failed:/,
  /^Failed to trigger s-read sync:/,
  /^Failed to read the s-read sync status:/,
  /^Failed to obtain Shopify access token:/,
  /^Participants page action failed:/,     // membership-ops/participants/page.tsx catches
  /^Attendance action failed:/,            // attendance/current/page.tsx catches
  /^Failed to update event:/,
  /^Zoho webhook received but ZOHO_WEBHOOK_SECRET is not configured\./,
  /^Zoho status sync failed for process/,
  /^Shopify webhook signature mismatch\./,
  /^Family trusted-adult ping failed:/,    // trusted-adult sweep: send fails, expiry still stands
  /^Failed to check out visit/,            // cron nightly per-visit failure injection
  /^Error in pass \d+ for row/,            // finance reconcile bad-row negative path
];

failOnConsole({
  shouldFailOnError: true,
  shouldFailOnWarn: false, // errors only this pass; warn (React act() noise) deferred
  allowMessage: (msg) => KNOWN_INTENTIONAL.some((re) => re.test(msg)),
});

// In-process attendance/certs cache survives across tests in a worker. Tests
// that write visits via prisma (not processCheckin) would otherwise see a
// stale roster from the previous case.
afterEach(() => {
  try {
    require('@/lib/getFullAttendance').invalidateAttendanceCache();
  } catch {
    // Module not loaded in this file.
  }
});
