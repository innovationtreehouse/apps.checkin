# Per-library local testing

## Problem

A developer or agent who changes one Inventory library has no light way to test
that change on their own machine. The only commands run a whole suite: every
unit test in the app, all 153 database-backed integration files, or every flow
journey on a full Docker stack. Several sessions running those suites at once
have overloaded the shared machine and frozen its Docker runtime. So people
either wait a long time for results that are mostly about code they did not
touch, or skip testing locally and leave it all to CI.

## Objective

A change to one library runs, locally, only that library's own tests and the
app's tests for how that library is wired in. The run finishes in seconds and
needs no database or Docker by default. Database and flow tests stay available
locally, but only as opt-ins limited to the changed area. CI keeps running every
suite exactly as it does today.

## Executive summary

- **For agents and developers:** one command reads what changed against
  `origin/main`, works out which areas those files belong to, prints the plan,
  and runs only the light checks for those areas, one at a time.
- **Light by default:** type-checks of the affected workspaces, lint on the
  changed app files, the library's unit tests with no database container, and
  the app unit tests that belong to the area. In the drafts measured before
  testing was stopped, a library change took about 8 s, a wiring change about
  6 s, and a shared-package change about 21 s, warm.
- **Opt-in heavy tiers, scoped to one area:** `--db` runs that library's
  database tier and the area's integration files. `--flow` runs that library's
  one flow file. `--all` refuses unless it is confirmed. **Neither `--db` nor
  `--flow` has been run; both are UNPROVEN.**
- **Unchanged:** CI, the existing test scripts, and every test file.
- **Cost:** one script with no new dependencies, plus two small enabling changes
  (a switch that turns off the library test-database container, and a way to
  pass a file list to the standalone flow run).

The rule this rests on is the owner's (Inventory parallel port plan, "Testing
follows the boundaries", 2026-10-09). Library logic is tested in the library,
and checkin tests only the wiring. A library whose tests can only be run
through the whole app counts as a boundary leak.

## Ownership map

Each library has one package and a fixed set of checkin paths that wire it in.
The **key** names its security tests: `src/security/__tests__/<key>-*.test.ts`
and `tests/security/<key>Admission.test.ts`. All checkin paths below are relative
to `checkin-app/`. Paths that do not exist yet belong to wiring that is still in
flight; they are listed so the map is right when it lands.

| Key | Package | Checkin wiring, routes, pages | Registry + classification | Flow test |
|---|---|---|---|---|
| catalog | `packages/global-catalog` | `src/lib/catalog/`, `src/lib/catalogNav.ts`, `src/app/catalog/`, `src/app/api/catalog/` | `src/security/registry/catalog.ts`, `src/security/catalogSyntheticClassifications.ts` | `flow-tests/catalog.flow.test.ts` |
| inventory | `packages/local-inventory` | `src/lib/localInventory/`, `src/app/inventory/`, `src/app/api/inventory/` | `registry/inventory.ts`, `inventorySyntheticClassifications.ts` | `flow-tests/local-inventory.flow.test.ts` |
| income | `packages/income` | `src/lib/income/`, `src/app/income/`, `src/app/api/income/` | `registry/income.ts`, `incomeSyntheticClassifications.ts` | none yet |
| expense | `packages/expense` | `src/lib/expense/`, `src/app/expense/`, `src/app/api/expense/` | `registry/expense.ts`, `expenseSyntheticClassifications.ts` | none yet |
| receipt | `packages/receipt` | `src/lib/receipt/`, `src/app/receipts/`, `src/app/api/receipts/` | `registry/receipt.ts`, `receiptSyntheticClassifications.ts` | none yet |
| workflow | `packages/workflow-mapping` | `src/lib/workflowMapping/`, `src/app/api/workflow-mapping/` | `registry/workflow.ts`, `workflowSyntheticClassifications.ts` | none yet |
| donation | `packages/bulk-donation` | `src/lib/bulkDonation/`, `src/app/donations/`, `src/app/api/donations/` | `registry/donation.ts`, `donationSyntheticClassifications.ts` | none yet |

**A library's tests** are its package's vitest suites, both the unit tier and
the database tier that the shared Postgres test harness boots. **The area's app
tests** are the jest tests that live under its checkin paths, plus its
key-named security tests.

The other workspaces are **shared packages** (`money`, `gtin`, `receipt-types`,
`workflows`, `quickbooks`, `receipt-contract-fixtures`, `pg-test-harness`,
`utils`, `telemetry`, `monitoring-db`, `s-ingest-core`, `donations`) and the
Lambda `*-function` workspaces. Everything else in `checkin-app/` is **checkin
core**.

The map is one constant in the script. When the shared `libraries.json` list
(H2b) lands on `main`, the key and package columns should come from it, so a new
library is added in one place.

## Change → local tests

The changed files are those that differ from the merge base with `origin/main`
(or `--base <ref>`), including uncommitted and untracked files. Each file
belongs to one area:

| Changed file is in | Local tests |
|---|---|
| a library package | tsc for checkin and any function workspace that consumes it; that library's vitest unit tier; the area's app tests; the library-boundary check |
| a library's checkin paths | tsc for checkin; eslint on the changed files; the area's app tests |
| a shared package | vitest unit for the package and its consumers; tsc for checkin and any function workspace among them; the app unit tests related to checkin files that import it |
| security or boundary files (`src/security/`, `src/middleware.ts`, `prisma/schema.prisma`, `tests/security/`) | everything the area needs, plus the whole security unit tier (about 44 files) |
| checkin core | tsc for checkin; eslint on the changed files; app unit tests related to the changed files, found by jest's related-tests search |
| docs, CI, deploy, root scripts | nothing |

Three details matter.

- **Fan-out follows runtime dependencies only.** If package A changes, every
  workspace that lists A as a dependency or dev dependency is tested. The search
  continues past a consumer only when it uses A at runtime. A dev dependency
  such as `pg-test-harness` reaches the packages that test with it, not their
  consumers in turn. Without this rule, a harness change pulled in 44 app tests
  that cannot be affected by it.
- **A library area uses path-owned tests, not jest's related-tests search.**
  Every library file is connected to the security registry and the navigation,
  so the related-tests search for one catalog change returned 74 files, most of
  them for other areas. The area's own paths returned 3. Related tests are used
  only for checkin core and for checkin files that import a changed shared
  package.
- **Wide changes go to CI.** If the related-tests search returns more than 80
  unit files, or more than 15 integration files, the command prints the list and
  stops. `--wide` overrides this. A change to a core file such as the database
  client is CI's to test. Both caps are guesses, not measurements (see Open
  before adoption).

## Default tier (light)

With no flags, the command runs only tiers that need no database or Docker:

1. `prisma generate` for checkin, if the worktree has no generated client yet. A
   fresh worktree fails tsc without it.
2. `tsc --noEmit` for each affected workspace that CI type-checks: checkin
   and the four `*-function` workspaces. CI does not type-check the
   `packages/*` workspaces, so the local run does not either. Otherwise it
   would fail where CI passes (see Known findings).
3. eslint, with no warnings allowed, on the changed checkin files. This matches
   CI's lint scope, which covers only checkin.
4. The library-boundary check, if a library or the harness changed.
5. `vitest run` for each affected workspace that has vitest, with
   `PG_TEST_HARNESS=off` and every `*DATABASE_URL` variable removed. **That
   switch does not exist on `main` yet; it is rollout step 1.** Today the
   harness skips only when it cannot reach Docker. Until step 1 lands, this
   step boots a Postgres container whenever Docker is up, so it is not light.
   Once the switch exists, the harness starts no container and each
   database-gated suite skips itself.
6. Jest unit tests as an explicit file list (`npm test -- --ci --forceExit
   --runTestsByPath …`). The list is built with `--listTests`, so jest's own
   ignore list still applies. That list excludes integration, flow and worktree
   tests, and the command never passes an ignore pattern by hand (see the
   jest-run skill).

Everything runs one step at a time. The plan, with each command, prints before
anything runs, and `--dry-run` prints it and exits.

Measured on three sample diffs before testing was stopped (warm, light tier
only):

| Sample diff | Plan | Time |
|---|---|---|
| one line in `packages/global-catalog/src` | tsc ×2, boundaries, catalog vitest unit (5 files pass, 6 DB files skip), 3 jest files | 8.3 s |
| one line in `checkin-app/src/lib/catalog/route.ts` | tsc, eslint, 3 jest files | 5.8 s |
| one line in `packages/money/src` | tsc ×8, vitest unit ×7, 7 jest files | 20.7 s |

These runs predate the CI-matched type-check scope. They type-checked every
affected package, so the `money` row's 8 tsc runs would now be 3 (checkin and
the two s-ingest functions).

A first run in a fresh worktree adds about 6 s for `prisma generate` and about
13 s for a cold checkin tsc.

## Opt-in tiers

All of this section is **UNPROVEN**: none of it has been run.

### `--db`

- **Library database tier.** For each library area, it runs the package's
  vitest normally: the shared harness boots one throwaway Postgres container and
  applies the package's migrations. This needs Docker. Its cost is one
  container start per library, about 1–2 s, plus migrations.
- **Checkin integration files for the area.** It builds the integration list in
  the same way as the unit list, but with the integration script's own pattern,
  and runs it with `npm run test:integration -- --forceExit --runTestsByPath …`.
  It refuses unless `DATABASE_URL` points at a running Postgres, and it never
  starts one itself.
- **Why a subset should work.** The integration setup does not depend on the
  whole suite. It migrates one template database and clones it once per jest
  worker, which is a file copy. The migrate step has not been timed here; an
  unmerged analysis of CI logs puts it at a few seconds. No integration file
  reseeds per test, and only `seed-helpers` truncates the schema. Every other
  file cleans up by its own tag. The suite's known slowdown comes from all 153
  files sharing one process. A run of 2–15 files does not have that problem.
- **Known gap.** The setup recreates and migrates the template on every run.
  For a handful of files that is the largest fixed cost. Reusing the template
  across runs is not worth doing until it is measured.
- **What an area actually gets today.** No library area has integration files
  under its paths yet, so `--db` on a library area runs only the package's
  database tier. A dry run of a core change to the program-year helper selected
  2 integration files. A dry run of a change to the kiosk-name helper selected
  55, which is over the cap.

### `--flow`

- It runs the area's one flow file. If `FLOW_BASE_URL` is set, it runs against
  that server (`npm run test:flow -- --runTestsByPath <file>`). Otherwise it runs
  on the standalone stack, through `test:flow:standalone` with the file passed
  in.
- **Known gap: file selection.** `test:flow:standalone` always runs every flow
  file and takes no arguments. Its command has to accept a file list, for
  example `npm run test:flow -- $FLOW_ARGS` inside the container, where an empty
  value keeps today's behaviour. CI does not use that script; its workflow runs
  the same commands itself.
- **Known gap: stack cost.** Startup is the expensive part, whichever file runs.
  The app container runs `npm ci`, migrates and seeds each library database,
  pushes and seeds the checkin schema, then starts `next dev`. The health check
  allows 240 s for this. The first file also pays for compiling every route it
  touches, which is why the flow timeout is 20 s. Expect minutes of setup for
  seconds of test.
- **Single-file feasibility.** Each flow file logs in through the seeded
  personas and assumes a freshly seeded database. One file on a fresh stack is
  the cleanest case of that assumption, so it should pass on its own. Nothing
  has confirmed this.
- **Coupling to H2b.** H2b's `libraries.json` work changes how the stack
  creates and seeds library databases. Re-check this section after it merges.

### `--all`

It prints that it would run `npm run test:all`, which is every app unit test
and every package and function vitest, database containers included. It refuses
unless `--yes` is also given.

## Agent rule

This is the text for `AGENTS.md`, under a new "Local testing for agents" heading
after "Test runners". It is applied only once the command is adopted (see the
migration file):

> **Local testing for agents.** Locally, run `npm run test:affected` from the
> repo root and nothing broader. It tests only the areas your diff touches and
> needs no database or Docker. The heavy tiers (the full jest suite, the
> integration suite, flow tests, and every package's database tier) come from
> CI. Do not run them locally to "make sure". To run a heavy tier for your area
> (`--db`, `--flow`), first ask your coordinator or user, and wait for a yes:
> any Docker-backed or database-backed run needs one. Never run `--all` or
> `--wide` unasked.

## Known findings

- `packages/s-ingest-core` fails `tsc --noEmit` on `main`. Its
  `test/globalSetup.ts` default-exports a value whose type uses
  `GlobalSetupContext`, which `pg-test-harness` does not export (TS4082). CI
  type-checks only checkin and the `*-function` workspaces, so nothing reports
  it. The light tier skips package type-checks to match CI and will not report
  it either. The fix is to export the interface from `pg-test-harness` (rollout
  step 1).

## Open before adoption

- `--db` and `--flow` have never been run. Rollout steps 4 and 5 prove them.
- The 80-unit and 15-integration caps are unmeasured. Set them from the timings
  of the first real `--db` runs and from a few core-change dry runs.
- The light vitest step depends on the harness switch (rollout step 1). Do not
  adopt the command before that lands.
- Should the AGENTS.md rule wait for `libraries.json` (H2b)? Until then, the
  ownership map lives as a constant in the script and has to be kept in step by
  hand.
