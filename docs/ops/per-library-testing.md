# Per-library local testing

`npm run test:affected`, run from the repo root, tests only what a change
touches. It finds the files that differ from the merge base with `origin/main`
(or `--base <ref>`), including uncommitted and untracked files, works out which
areas they belong to, prints the plan, and runs the light checks for those
areas one at a time. The default run needs no database or Docker. CI still runs
every suite; this command never replaces it.

The rule agents follow is in `AGENTS.md`, under "Local testing for agents".

The split rests on the owner's rule (2026-10-09): "Library logic is tested in
the library, and checkin tests only the wiring. A library whose tests can only
be run through the whole app counts as a boundary leak."

## Flags

| Flag | Runs | Needs |
|---|---|---|
| (none) | The light tier, below | Nothing |
| `--dry-run` | Prints the plan and exits | Nothing |
| `--db` | Adds the library's database tier and the area's integration files | Docker, and `DATABASE_URL` set to a running Postgres |
| `--flow` | Adds the area's flow files | Docker, or `FLOW_BASE_URL` for a server already up |
| `--wide` | Runs related-test lists past the caps | Ask first |
| `--all --yes` | `npm run test:all`: every suite, database containers included | Ask first |

## Ownership map

Each library has one package and a fixed set of checkin paths that wire it in.
The libraries and their packages come from `checkin-app/libraries.json`. The
`WIRING` table in `scripts/test-affected.mjs` adds the rest, keyed by library
name: the security-test key, the checkin paths, and the flow files. A
`libraries.json` entry with no `WIRING` entry stops the command with an error.

The **key** names a library's security tests, where they exist:
`src/security/__tests__/<key>-*.test.ts` and
`tests/security/<key>Admission.test.ts`. Checkin paths are relative to
`checkin-app/`.

| Library | Key | Checkin wiring, routes, pages | Registry + classification | Flow test |
|---|---|---|---|---|
| catalog | catalog | `src/lib/catalog/`, `src/lib/nav/sections/inventory.ts`, `src/app/catalog/`, `src/app/api/catalog/` | `src/security/registry/catalog.ts`, `src/security/catalogSyntheticClassifications.ts` | `flow-tests/catalog.flow.test.ts` |
| local_inventory | inventory | `src/lib/localInventory/`, `src/app/inventory/`, `src/app/api/inventory/` | `registry/inventory.ts`, `inventorySyntheticClassifications.ts` | `flow-tests/local-inventory.flow.test.ts` |
| income | income | `src/lib/income/`, `src/app/income/`, `src/app/api/income/` | `registry/income.ts`, `incomeSyntheticClassifications.ts` | `flow-tests/income.flow.test.ts` |
| expense | expense | `src/lib/expense/`, `src/app/expense/`, `src/app/api/expense/` | `registry/expense.ts`, `expenseSyntheticClassifications.ts` | `flow-tests/expense.flow.test.ts` |
| receipt | receipt | `src/lib/receipt/`, `src/app/receipts/`, `src/app/api/receipts/` | `registry/receipt.ts`, `receiptSyntheticClassifications.ts` | `flow-tests/receipt.flow.test.ts`, `flow-tests/receipt-pipeline.flow.test.ts` |
| workflow_mapping | workflow | `src/lib/workflowMapping/`, `src/app/api/workflow-mapping/` | `registry/workflow.ts`, `workflowSyntheticClassifications.ts` | `flow-tests/workflow-mapping.flow.test.ts` |
| bulk_donation | donation | `src/lib/bulkDonation/`, `src/app/donations/`, `src/app/api/donations/` | `registry/donation.ts`, `donationSyntheticClassifications.ts` | `flow-tests/bulk-donation.flow.test.ts` |

**A library's tests** are its package's vitest suites: the unit tier, and the
database tier that the shared Postgres test harness boots. **The area's app
tests** are the jest tests under its checkin paths, plus its key-named security
tests.

The other workspaces are **shared packages** (`money`, `gtin`, `receipt-types`,
`workflows`, `quickbooks`, and the rest of `packages/*`) and the Lambda
`*-function` workspaces. Everything else in `checkin-app/` is **checkin core**.

## Change → local tests

| Changed file is in | Local tests |
|---|---|
| a library package | tsc for checkin and any function workspace that consumes it; that library's vitest unit tier; the area's app tests; the library-boundary check |
| a library's checkin paths | tsc for checkin; eslint on the changed files; the area's app tests |
| a shared package | vitest unit for the package and its consumers; tsc for checkin and any function workspace among them; the app unit tests related to checkin files that import it |
| security or boundary files (`src/security/`, `src/middleware.ts`, `prisma/schema.prisma`, `tests/security/`) | everything the area needs, plus the whole security unit tier |
| checkin core | tsc for checkin; eslint on the changed files; app unit tests related to the changed files, found by jest's related-tests search |
| docs, CI, deploy, root scripts | nothing |

- **Fan-out follows runtime dependencies only.** A change to package A tests
  every workspace that lists A as a dependency or dev dependency. The search
  goes past a consumer only when it uses A at runtime, so a dev dependency such
  as `pg-test-harness` reaches the packages that test with it and stops there.
- **A library area uses path-owned tests, not jest's related-tests search.**
  Every library file connects to the security registry and the navigation, so
  the related-tests search for one library file returns tests for most other
  areas. Related tests are used only for checkin core and for checkin files that
  import a changed shared package.
- **Wide changes go to CI.** If the related-tests search returns more than 80
  unit files, or more than 15 integration files, the command skips that step,
  names the count, runs the rest of the plan and exits 1. `--wide` overrides
  this. The 15-file cap is checked against the `--db` timings below; the
  80-file cap is still a guess, to be set from a few core-change dry runs.

## Light tier (default)

1. `prisma generate` for checkin, if the worktree has no generated client yet.
2. `tsc --noEmit` for each affected workspace that CI type-checks: checkin and
   the `*-function` workspaces. CI does not type-check `packages/*`, so neither
   does this; a package type error goes unreported by both.
3. eslint, with no warnings allowed, on the changed checkin files.
4. The library-boundary check, if a library or the test harness changed.
5. `vitest run` for each affected workspace, with `PG_TEST_HARNESS=off` and every
   `*DATABASE_URL` variable removed. The harness starts no container and each
   database suite skips itself.
6. Jest unit tests as an explicit file list, built with `--listTests` so jest's
   own ignore list still applies.

Typical warm times: a library-package change about 8 s, a library-wiring change
about 6 s, a shared-package change about 20 s. A fresh worktree adds about 6 s
for `prisma generate` and about 13 s for a cold checkin tsc.

## `--db`

- **Library database tier.** For each library area, it runs the package's
  vitest with `PG_TEST_HARNESS` unset and `REQUIRE_DB=1`. The shared harness
  boots one throwaway Postgres container and applies the package's migrations.
  With no Docker the database suites fail instead of skipping.
- **Checkin integration files for the area.** It builds the integration list as
  it builds the unit list, and runs it with `npm run test:integration --
  --forceExit --runTestsByPath …`. It refuses unless `DATABASE_URL` is set, but
  does not check that the database is up, and it never starts one itself. The integration setup
  migrates one template database and clones it per jest worker, so a handful of
  files runs on its own.
- An area's integration files are the `*.integration.test.ts` files under its
  checkin paths. Catalog, bulk_donation and workflow_mapping have some; for the
  other library areas `--db` runs only the package's database tier.
- **Measured** (catalog, 2026-10-17, shared machine at load about 4.5): the
  light tier took 41 s, 22 s of it a cold checkin tsc. The catalog database tier
  took 47 s for 16 files, container start included. The one integration file
  took 186 s. Of that, about 111 s was migrating the template database (84
  migrations), and 70 s was the file itself, including a 60 s teardown hook.
- **Fixed cost dominates.** Migrating the template is about two minutes
  whichever files run, so a handful of integration files costs little more than
  one. The 15-file cap guards against a core change reaching half the suite,
  not against per-file cost.
- **Slow teardown under load.** `reader.integration.test.ts` drops its own
  database in `afterAll` with `WITH (FORCE)`, which waits on a checkpoint. Under
  IO load that can pass the 60 s hook limit and fail the suite after every test
  has passed. Re-run it when the machine is quieter before treating it as a real
  failure.

## `--flow`

- With `FLOW_BASE_URL` set, it runs the area's flow files against that server
  (`npm run test:flow -- --runTestsByPath <file>`). Otherwise it runs
  `test:flow:standalone` with `FLOW_ARGS` set to those files, which brings up
  `deploy/docker-compose.flow.yml`, runs them in the app container, and takes
  the stack down with `down -v`.
- Start-up is the expensive part. The app container runs `npm ci`, migrates and
  seeds one database per entry in `checkin-app/libraries.json`, migrates (never
  `db push`) and seeds the checkin schema, then starts `next dev`. The first file also pays for
  compiling every route it touches.
- `deploy/docker-compose.flow.yml` lists each library's database URLs and
  passwords by hand. Re-check this section, and that file, whenever
  `checkin-app/libraries.json` changes.
- Each flow file logs in through the seeded personas and assumes a fresh seed.
  One file alone on a fresh stack passes.
- The stack's compose project is named after its directory, `deploy`, so two
  worktrees running it at once share containers. Set `COMPOSE_PROJECT_NAME` to
  something unique to the worktree. The app always binds host port 4000.
- **Measured** (catalog, 2026-10-17): `catalog.flow.test.ts` ran its 10 tests
  in 6 s. The whole standalone step, start-up and `down -v` included, took
  362 s, so start-up is about six minutes for seconds of test.

## Browser e2e tests

`test:affected` does not run the browser tier. It runs in CI
(`.github/workflows/e2e-tests.yml`) on the same dev-server stack as `--flow`.
Run it locally only when your coordinator or user says yes, as with any
Docker-backed tier.

- `npm run test:e2e:standalone` (from `checkin-app/`) brings up
  `deploy/docker-compose.flow.yml`, installs Chromium in the app container,
  runs `playwright test` there, and takes the stack down with `down -v`. Set
  `E2E_ARGS` to pass arguments through, for example a spec file or `--grep`.
- With a seeded dev server already up (`CHECKIN_ENV=local`), `npm run test:e2e`
  runs against `FLOW_BASE_URL` (default `http://localhost:4000`). Install a
  browser first with `npx playwright install chromium`.
- Start-up costs the same as `--flow`. Each spec logs in through the seeded
  personas and assumes a fresh seed.
- On failure, CI uploads the HTML report and traces as the `playwright-report`
  artifact. Open a trace with `npx playwright show-trace <trace.zip>`.
