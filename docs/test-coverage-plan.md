# Test coverage plan — `checkin-app`

**Status: target met and now CI-enforced.** `checkin-app/coverage-floor.json`, read by `jest.config.js`,
sets the global floor (gated by
`SKIP_COVERAGE_THRESHOLD`), exceeding the original 80%-lines goal. The dated
47.6% baseline (2026-07-01) that motivated this plan is obsolete — the tooling is
the ground truth now: `npm run test:coverage` from `checkin-app/`.

## What shipped (the plan's phases)

- **Shared RTL harness** (the Phase-2 prerequisite) → `src/test-helpers/rtl.tsx`
  (session/router/Mantine/jsdom + `fetch` stub), so page tests don't each
  reinvent it. Excluded from coverage via `!src/test-helpers/**`.
- **Phase 1** (mop-up) → the ~12 `layout.tsx` tests, hook tests, and API-route
  stragglers landed.
- **Phase 2** (shell + panels) → `src/components/__tests__/AppFrame.test.tsx` and
  the admin-panel tests.
- **Phases 3–4** (pages) → ~66 of 82 `page.tsx` files now have a `page.test.tsx`.
  The plan's "0/68 pages rendered by any test" no longer holds.

## Decisions that still stand

- **Dev-only files stay in coverage scope.** The "fairness cleanup" idea to
  exclude `Dev*.tsx` / `lib/dev/actions.ts` was **not** adopted — they were tested
  instead and pull their weight. `collectCoverageFrom` excludes only generated
  code, `types/**`, and `test-helpers/**`.
- **Don't chase 100% per file.** Rare validation branches and modal error paths on
  500+ line pages are a reasonable line-coverage ceiling; the global threshold,
  not per-file perfection, is the gate.

## Forward remainder

~16 `page.tsx` files still lack a dedicated render test (many are thin
`redirect()` stubs needing a one-line "renders and redirects" check). The global
threshold already passes, so these are not blocking — add them opportunistically
by mirroring an existing `*.test.tsx` + `src/test-helpers/rtl.tsx`.
