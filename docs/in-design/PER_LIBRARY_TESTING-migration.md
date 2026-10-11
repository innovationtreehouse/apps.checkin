# Per-library local testing: rollout

One-time steps to adopt `PER_LIBRARY_TESTING.md`. Every step is local tooling;
none of them changes CI.

## State now

- `scripts/test-affected.mjs` is an **unadopted draft**. No package.json script
  points to it. Its light tier ran on three sample diffs (timings are in the
  design doc) before testing was stopped. `--db`, `--flow` and `--all` have
  never been run.
- The two enabling changes it relies on are not made. Without them the light
  vitest step starts a database container whenever Docker is up, and `--flow`
  runs every flow file.

## Steps

1. **Harness opt-out.** In `packages/pg-test-harness/src/globalSetup.ts`, when
   `PG_TEST_HARNESS=off`, provide `undefined` and start no container, the same
   path it already takes when Docker is absent. Add one unit test next to the
   existing no-Docker test. In the same PR, export `GlobalSetupContext`, which
   fixes the `s-ingest-core` TS4082 error.
2. **Flow file selection.** Change `test:flow:standalone` in
   `checkin-app/package.json` to run `npm run test:flow -- $FLOW_ARGS` inside the
   container. An empty `FLOW_ARGS` keeps today's run-everything behaviour.
3. **Adopt the script.** Add `"test:affected": "node scripts/test-affected.mjs"`
   to the root `package.json`, and remove the DRAFT header from the script.
   Check `--dry-run` against the three sample diffs.
4. **Prove `--db`, with an explicit go-ahead.** Run one small area against a
   throwaway Postgres. Record the template-migrate time against the file time,
   and confirm the 15-file cap is the right size.
5. **Prove `--flow`, with an explicit go-ahead.** Run
   `flow-tests/catalog.flow.test.ts` alone on the standalone stack, then take it
   down with `down -v`. Record stack start-up time against test time, and
   confirm a single file passes on a fresh seed. If it does not, record what it
   depends on.
6. **Agent rule.** Paste the "Agent rule" block from the design doc into
   `AGENTS.md` as "Local testing for agents", and point the jest-run skill at
   it.
7. **After H2b merges,** take the key and package columns of the ownership map
   from `checkin-app/libraries.json`, and re-check the `--flow` stack notes.
8. **Retire.** Move the ownership map and tier description into `docs/ops/` as
   operational reference, and delete both working docs.
