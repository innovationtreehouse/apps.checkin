// Node environment setup for Route Handler integration tests.
// The Postgres URL is published by test/setupEnv.ts (the harness container); this file only
// sets the non-DB env the route handlers read.
process.env.JWT_SECRET = "test-secret-for-tests";
process.env.RECEIPT_SERVICE_KEY = "test-service-key";
