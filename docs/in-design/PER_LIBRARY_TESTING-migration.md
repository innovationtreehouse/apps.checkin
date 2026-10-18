# Per-library local testing: rollout

One-time steps to adopt `PER_LIBRARY_TESTING.md`. Every step is local tooling;
none of them changes CI.

## State now

- Steps 1–3 are done. `npm run test:affected` at the repo root runs
  `scripts/test-affected.mjs`. Its light vitest step starts no database
  container, and `--flow` on the standalone stack runs only the area's file.
- `--db`, `--flow` and `--all` have never been run. Steps 4 and 5 prove the
  first two.

## Steps

1. **Done: harness opt-out.** In `packages/pg-test-harness/src/globalSetup.ts`, when
   `PG_TEST_HARNESS=off`, the setup provides `undefined` and starts no
   container, the same path it takes when Docker is absent. A unit test sits
   next to the no-Docker test. `GlobalSetupContext` is exported, which fixes
   the `s-ingest-core` TS4082 error.
2. **Done: flow file selection.** `test:flow:standalone` in
   `checkin-app/package.json` runs `npm run test:flow -- $FLOW_ARGS` inside the
   container. An empty `FLOW_ARGS` runs every flow file.
3. **Done: adopt the script.** The root `package.json` has
   `"test:affected": "node scripts/test-affected.mjs"`, and the script has no
   DRAFT header. `--dry-run` gives the expected plan for the three sample diffs.
4. **Prove `--db`.** The owner approves this run once the tests make sense; it
   runs on the coordinator's heavy-job go, within its load limits. Run one small area against a
   throwaway Postgres. Record the template-migrate time against the file time,
   and confirm the 15-file cap is the right size.
5. **Prove `--flow`,** under the same approval and load limits as step 4. Run
   `flow-tests/catalog.flow.test.ts` alone on the standalone stack, then take it
   down with `down -v`. Record stack start-up time against test time, and
   confirm a single file passes on a fresh seed. If it does not, record what it
   depends on.
6. **Agent rule.** Paste the "Agent rule" block from the design doc into
   `AGENTS.md` as "Local testing for agents", and point the jest-run skill at
   it. This does not wait for step 7.
7. **When a library is next added,** take the key and package columns of the
   ownership map from `checkin-app/libraries.json`, and re-check the `--flow`
   stack notes. None is planned for a while.
8. **Retire.** Move the ownership map and tier description into `docs/ops/` as
   operational reference, and delete both working docs.
