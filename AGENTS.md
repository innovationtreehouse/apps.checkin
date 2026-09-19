# AGENTS.md

Orientation for agents working in this repo. The app is a Next.js + Prisma +
PostgreSQL membership/check-in system under `checkin-app/`.

## Editing files

Before a multi-file edit sweep, Read every target file first — batch all the
Reads in one round — then Edit. Don't interleave read/edit/read/edit; the
harness rejects any Edit/Write on a file you haven't Read this session ("File
has not been read yet"), so front-loading the Reads avoids a stall per file.
After a `git merge`/`rebase`/`cherry-pick` (or any external write) touches a
file you're about to edit, re-Read it first — it counts as modified since your
last Read.

## Comments

A code comment describes what the code below it does and why it exists **now**,
in the present tense. Keep it short — usually one line. Prefer making the code
self-explanatory (better names, smaller functions) over explaining it.

- **No history in comments.** Don't narrate how the code got here: no "used
  to…", "previously…", "changed because…", "workaround for the old…", bug/PR
  numbers, TODO-from-2023, or a log of past attempts. That context belongs in
  the PR description and commit message, where it's linked to the diff and
  reviewable — not stranded in the source where it rots.
- **A "why" comment is fine when the reason is non-obvious and still true** —
  an ordering constraint, an external-API quirk, a security invariant. State
  the constraint, not the story of discovering it.
- **Delete stale comments when you touch the code.** A comment that no longer
  matches the code is worse than none.
- If a comment needs multiple paragraphs to make sense, that's usually a signal
  the code or its name should change instead.

Design rationale, regressions-to-learn-from, and past approaches live in
`docs/` and PR history — not in code comments. (This file's own flow-test
section is an example: the failure stories sit in docs, not in the source.)

## Lint and type errors

A suppressed error is an error the next reader cannot see. Fix what the tool is
pointing at, not the fact that it is pointing.

- **Never fix a lint error by disabling the linter.** No
  `// eslint-disable-next-line`, no `/* eslint-disable */`, no
  `@ts-expect-error`, no `@ts-ignore`.
- **Never fix a type error with an `any` coercion.** Type the variables,
  parameters and return signatures properly. Where the type isn't immediately
  obvious, use `unknown` and narrow it, or define the interface.
- **Address the root cause** — the logic, the missing type, the interface that
  wasn't imported — rather than the message.

## Test runners: Jest for the app, Vitest for everything else

Two runners, split by workspace type — no file ever runs under both (issue #228):

- **`checkin-app/` → Jest** (jsdom + RTL + ts-jest + next). The three classes
  below are all Jest; run their commands from `checkin-app/`.
- **`packages/*` and `*-function` → Vitest.** Each such workspace owns its own
  `vitest.config.ts` + `vitest` devDep — no shared root config. Real-Postgres
  integration tiers boot a throwaway container via `@inventory/pg-test-harness`
  (testcontainers), so they need a running Docker daemon and self-skip without
  one.

Root aggregate scripts (run from the repo root): `test` (app Jest, the default),
`test:packages` (`vitest run` across every `packages/*`), `test:functions`
(across every `*-function`), `test:all` (all three). CI runs the Jest tiers and
the Vitest tier (`package-tests` job) as separate path-filtered lanes. Jest's
`rootDir` is `checkin-app/`, so it never collects a sibling workspace's
`.test.ts` — a Vitest file cannot leak into the Jest run.

## Test classes

There are **three** classes of tests. Run all commands from `checkin-app/`.

### 1. Unit tests — `*.test.ts(x)`
In-process, no database. `@/lib/prisma`, `next-auth`, and `fetch` are mocked in
`jest.setup.js`. Run: `npm run test:ci` (this is the CI default). These must
never hit a real DB — the prisma mock rejects real calls.

### 2. Integration tests — `*.integration.test.ts`
In-process, but talk to a **real Postgres** via `DATABASE_URL` (the prisma mock
defers to the real client for these). They import service functions directly and
assert DB state. Excluded from the default run. Run: `npm run test:integration`
against a live DB. Each suite self-cleans by a unique `TAG`.

### 3. Flow tests — `flow-tests/*.flow.test.ts`  ← read this before adding e2e
**End-to-end user journeys driven over HTTP against a *running* dev server.** No
app imports, no DB access, no mocks — a flow test only `fetch()`es the server and
asserts responses, exactly as a client would. This is how we verify a whole
journey (intake → review → payment, check-in, etc.) wired through the real
routes, auth, and DB together.

- **Config:** `jest.flow.config.js` (node env, **skips `jest.setup.js`** so it
  uses native `fetch` with `getSetCookie` and no prisma/next-auth mocks).
- **Run locally, no setup:** `npm run test:flow:standalone` (from `checkin-app/`)
  — brings up `deploy/docker-compose.flow.yml` (Postgres + seeded dev server),
  runs the suite inside that container, tears down. This is what CI does; use
  it unless you already have a dev server running.
- **Run against a server you already have up:** start the app (`npm run dev`,
  serves `:4000`) against a seeded local DB, then `npm run test:flow`. Bare
  `test:flow` does NOT start anything — it assumes `:4000` is already live and
  fails with a connection error otherwise. Override the target with
  `FLOW_BASE_URL=http://host:port`.
- **Auth:** `flow-tests/helpers.ts` → `loginAs(email)` signs in via the local
  **persona-mint** flow (resolves the seeded persona by its stable email, since
  ids are autoincrement) and returns a cookie jar; `api(session, path, init)`
  is a thin JSON `fetch` wrapper.
- **In CI:** the `Flow tests` workflow (`.github/workflows/flow-tests.yml`) brings
  up `deploy/docker-compose.flow.yml` — Postgres + a **dev-mode** app container
  (`next dev`) — installs, `prisma db push`, seeds, then runs the flow tests
  inside that container.

**Gotchas (why it's built this way):**
- Use the **dev** server, never the production image: persona-mint login is gated
  on `NODE_ENV != production`, and the prod `Dockerfile` pins `NODE_ENV=production`.
  So flow tests would have no way to authenticate against the prod image.
- The server must run with `CHECKIN_ENV=local` (enables persona-mint) and a
  **freshly seeded** DB (`prisma db seed`) — flow tests assume the seed's baseline
  personas/households (e.g. `parent.family2@example.com` is a non-member household
  lead; `boardmember@example.com` is sysadmin+board).
- Flow tests **mutate** seeded state, so they assume a fresh seed per run (CI
  reseeds every run). Don't rely on re-running against the same DB locally.
- `*.flow.test.ts` is excluded from the unit/integration runs (it needs a live
  server) — keep it that way; run it only via `npm run test:flow`.
- `*.shopify-live.ts` (`checkin-app/shopify-live/`) hits the REAL Shopify
  dev store — excluded from every local/CI run; executed only by
  `.github/workflows/shopify-live.yml` (`npm run test:shopify-live`). Dev-store-only
  by a triple guard; see `docs/ops/shopify-live-tests.md`.
  Deliberately NOT named `*.test.ts`: that keeps them structurally invisible to
  every other jest invocation, including scripts that override ignore patterns
  on the CLI (the test:coverage class).
- **No test tier exercises real Google OAuth.** Flow tests authenticate via
  persona-mint (a credentials sign-in), which — with JWT sessions — never
  touches the NextAuth **PrismaAdapter**; the adapter's user methods run only
  inside the live Google OAuth callback. The adapter↔model mapping in
  `checkin-app/src/lib/auth-options.ts` is guarded by tsc (keep the
  `user: prisma.person` reference cast-free) and by
  `src/lib/__tests__/auth-options-adapter.test.ts`. Regression to learn from:
  the Participant→Person rename (#708) left `.participant` in that mapping
  behind an `as` cast — CI stayed fully green while every Google sign-in on
  the dev instance 500'd in the OAuth callback.

To add a journey: drop a `flow-tests/<name>.flow.test.ts` using `loginAs`/`api`,
keep it to real HTTP calls + response assertions. Prefer routes that don't need
external integrations (Zoho/Shopify/Averity); use the board/admin manual-action
routes to advance flows those would otherwise gate. Real journeys are catalogued
in `docs/backlog/CUJS.md` — start there when choosing what to cover.

## Issue workflow (org project 1)

Org **project 1** is the canonical triage surface; its Status field plus the
issue's assignee are the claim-state machine. An assignment means exactly one
thing: someone is actively working the issue *right now* — never leave one
standing as a soft reservation, and never trust it as the only signal.

- **Pick up**: choose an open issue that is unassigned **and** has no open PR
  claiming it. That check is two-pronged, because design PRs don't create a
  closing link: (1) `closingIssuesReferences` on open PRs / the issue's
  Development panel (implementation PRs), and (2) open PRs whose title/body
  mention `#NNN` and carry a design doc for it. Assignment is dropped when a
  PR opens, so "unassigned" alone does not mean free. Then assign yourself and
  set Status → **In progress**.
- **Re-verify before building**: issue bodies go stale — renames, moved files,
  callers added since filing. Re-run the blast-radius search against current
  `main` before implementing, and comment corrections on the issue (see #300:
  filed against `isMinor`/3 callers, fixed as `isYouth`/10 callers).
- **PR open**: set Status → **In review** and **unassign the issue**. The next
  action belongs to reviewers, not the author; a standing assignment would
  claim work that isn't happening. The open PR is what marks the issue as
  taken. How the PR references the issue depends on what it is:
  - **Implementation PR**: a closing keyword — `Fixes #NNN`, `Closes #NNN`,
    or `Resolves #NNN` (all three work) — and confirm the link registered via
    `closingIssuesReferences`.
  - **Design-doc PR**: reference the issue WITHOUT a closing keyword (plain
    `#NNN`, "Design for #NNN"). A closing link here would auto-close the
    issue when the doc merges, with nothing implemented.
- **Merge**: an implementation PR needs nothing manual — the closing keyword
  closes the issue and the project's built-in workflows (Item closed / Pull
  request merged) set Status → Done. A merged design-doc PR leaves the issue
  open: set Status back to **Ready** for implementation pickup.

Project-field writes need the `project` token scope; if GraphQL returns
INSUFFICIENT_SCOPES, have the user run `gh auth refresh -s project`.

## Your own open PRs

Before opening a PR, search open **and recently closed** PRs for the same fix —
by the file you are about to touch and by the finding, not just by title. If one
exists, that PR *is* the work: push to its branch. A second PR for a fix that
already has one is never the right move, whoever opened the first.

An open PR you authored carrying **CHANGES_REQUESTED**, or unresolved review
comments, is your next task — ahead of any new finding. Address it or argue it
on the thread. Do not leave it and start something else.

- **Never re-file instead of revising.** Abandoning a reviewed PR and opening a
  fresh one with the same fix launders unaddressed feedback into a clean slate:
  the same review gets written twice and the defect the first review named ships
  anyway. This is the failure to avoid, and it has happened: #1479 was told on
  2026-08-03 that its `sandbox` value broke the dev mail viewer's link
  click-through; #1617 arrived six days later with the identical flags, the
  identical claim that links stayed clickable, and no reference to #1479.
- **Disagreeing is fine; ignoring is not.** If you think a review is wrong —
  including on security grounds, and including when the reviewer is not the
  repo owner — say so on the PR and let the owner settle it. Unwillingness to
  take a reviewer's advice is not a licence to re-file: silence plus a duplicate
  reads as feedback evasion, and it costs the reviewer the same work twice.
- Same rule for a finding already **rejected**. Re-raising it needs new evidence
  named in the body, not a new PR number.

## Reviewing a PR

A review comment earns its place only if a careful human reading the diff would
**miss** the problem. Everything the merge itself surfaces is already known —
saying it again is noise the reader has to scroll past to find the real finding.

Do **not** comment on:

- **Merge state** — behind `main`, needs a rebase, conflicts, stale branch. The
  merge box says this.
- **CI state** — failing tests, lint, type errors, coverage drops. The checks
  say this, with the actual output.
- Anything else a bot or the GitHub UI already reports on the PR.

Do comment on what only reading the code reveals — a silent behavior change, a
missed caller, a broken invariant, a data-loss or security hole, a migration
that isn't safe against the old code still serving traffic.

Exception: a mechanical failure is worth a comment when the **cause** is
non-obvious and named — "these three tests fail because the rename missed
`scopeBindings.ts`" is a finding; "tests are broken" is not. Nothing to say
means say nothing, or approve.

## Docs map

Read these before changing the relevant area — start here, then follow links.

**Domain rules — read first** (`docs/rules/`)
- The register of board and operations decisions, and the invariants a change must not violate: `membership.md`, `programs.md`, `people-households.md`, `finance-payments.md`, `attendance-checkin.md`, `tools-certification.md`, plus `principles.md` for the cross-cutting ones. **Before changing behaviour in a domain, read its file.** If a change contradicts a rule there, raise it — do not quietly proceed. A **Policy**-tier rule is not negotiable in a PR at all: stop and escalate.
- `docs/DOCUMENTATION_STANDARD.md` — how documentation is organised, written, and retired: the document classes, what belongs in the register and what does not, the citation and format rules, and the working-doc lifecycle (write it in `docs/in-design/`, extract standing rules and delete it at merge). Read before writing or moving any doc.
- `docs/conventions.md` — how we build, independent of any domain.

**Project-wide**
- `README.md` — what the app is + Quick Start; OS setup: `docs/setup/SETUP_LINUX.md`, `docs/setup/SETUP_MACOS.md`.
- `docs/backlog/CUJS.md` — **critical user journeys**, per step with state tags (the basis for flow tests); `docs/backlog/INDEX.md` is the gap inventory behind it.
- `CONSTITUTION.md` — project principles//ground rules.
- `docs/WRITING_STANDARD.md` — how agents write: docs prose, PR/issue bodies, review comments, session replies. Voice only; the Comments section above still governs code comments.
- `GEMINI.md`, `.jules/sentinel.md` — instructions for other agents (Gemini, Jules); keep cross-consistent with this file.
- `TRADEMARKS.md` — naming/brand constraints.

**Design & product** (`docs/designs/`)
- `DESIGN.md` — system design overview.
- `docs/ops/dev-instance.md` — the `CHECKIN_ENV` prod/dev/local model, persona-mint/impersonation, and the dev dashboard's seed macros / reset / ledger (read before touching auth/env, or before adding anything that must not exist in prod).
- `PRODUCTION_PLAN.md`, `ARCHITECT_IDEAS_*.md` — roadmap/scoping notes.

**Security** (`docs/security/`)
- `SECURITY-POLICY.md` — the response-stripper / `@sensitivity` registry rules (read before adding API responses or schema fields).
- `pentest_findings_2026-04-21.md` — prior findings.
- **Boundary isolation rule**: the handler/registry layer (`checkin-app/src/security/`) exists to make the data policy easy to AUDIT — it is not a substitute for careful route management (tight selects, deliberate response shapes). Any change to the boundary itself — registry grants, token grammar, handler/stripper, scope bindings, or a re-tier of an existing field's `@sensitivity` — must ship **in its own PR** (tests/docs/schema annotations may accompany; no app/feature code). New registered route: land the registry entry PR first (an unused `defineRoute` is inert), then the route PR. CI-enforced by `.github/workflows/security-boundary-isolation.yml`. `checkin-app/src/middleware.ts` counts as a boundary file — it is the site-wide org-login/access gate and nothing imports it, so deleting or renaming it leaves tsc and the build green; a PR touching it ships alone. Security *tests* (`src/security/__tests__/`) are companions, not boundary files. One exception, for decommissions: a boundary diff that only removes *whole* entries whose subjects cease to exist in the same PR (model dropped from schema, route file/verb deleted) may ship with the drop migration and the route files of the removed registry entries — no other deletion — certified fail-closed by `checkin-app/scripts/check-boundary-decommission.js`; see `checkin-app/docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` rule 7.
  - **Stacking hazard — base the route PR on `main`, not on the registry branch.** Registry-first means two PRs, and stacking the second on the first strands it: when the registry PR merges, the route PR still targets a branch tip nothing will ever merge, while GitHub reports it `MERGED` once you merge it there. Its code never reaches `main`, and a closed PR cannot be retargeted — recovery is a cherry-pick into a fresh PR. This happened to #1447 (stranded on `claude/registry-turning-18` behind #1490; re-landed as #1495). **After any stacked merge, confirm the files are on `main`** (`git show origin/main:<path>`) rather than trusting the PR state.

**Deploy & migrations** (`checkin-app/docs/`)
- `DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` — infra rules + order of operations for schema migrations vs. deploys (read before writing a migration); `.claude/skills/migration-safety/` fires this as a checklist whenever a migration is being built.
- `MIGRATION_COALESCE_FLOW.md` — the migration-coalesce script (`scripts/coalesce-migrations.ts`) for squashing a long unreleased tail, and the dev/prod ledger-reconcile procedure.
- `PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` — single-pool Shopify capacity model + the scholarship hold-ledger state machine (read before touching `Program`/`ProgramParticipant` capacity or payment-plan logic).

**Subprojects** (each has its own `README.md`)
- `client/` — the Raspberry-Pi kiosk client (Python).
- `packages/*` (e.g. `monitoring-db`, `pg-test-harness`, `telemetry`), `layers/prisma-runtime/`, and the Lambda `*-function/` dirs (`s-read-function/`, `s-replay-function/`, `monitoring-relay-function/`, `monitoring-watchdog-function/`) — see the README in each; `s-read-function/` also has `MONITORING-PRD.md` + `FUTUREWORK.md`.
