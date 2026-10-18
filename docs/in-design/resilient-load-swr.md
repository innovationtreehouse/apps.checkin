# Resilient, status-aware page loads on SWR

**Status: DESIGN ONLY — not implemented.** Verified against this tree: `swr` is
not in `package.json` (nor on `main`), no `useLoad`/`loadFetcher` module exists,
and nothing in `src` imports `useSWR`/`SWRConfig`. This doc is the decision
record for that unbuilt work; there is no shipped code to be ground truth for it
yet, so the decisions below *are* the contract. (Merged in the engine choice
from the former `data-fetching-hook-migration.md`, now deleted.)

## The problem

The app hand-rolls ~40 `useState`+`useEffect`+`fetch` loaders (48 `page.tsx`
files match the pattern today; the count drifts — re-grep before scoping). None
retry, none `AbortController`, and most collapse every failure into one `res.ok`
check: a network blip on emergency-contacts shows a permanent red "Failed to
load. Ensure you have the proper authorizations." — wrong (it was a blip, not a
permission problem) and dead-ended. Recurring bug classes fall out of the
hand-roll: stale-response races (no abort), silent-swallow (blank state on
failure), and tone/string-sniffing error UI.

Scope of *this* design: the narrow **resilience layer** over the ~24 GET-on-mount
loaders — a shared `useLoad` hook with retry/backoff and status-aware terminal
states. The broader fetch-pattern migration (debounced search, refetch-on-
mutation, action fetches across all ~40 pages) is the same engine applied wider
and is out of scope here.

## Engine decision: SWR (not react-query, not a hand-rolled `useFetch`)

The bug classes above are exactly what SWR/react-query give for free — request
dedup, stale-response cancellation on key change, `mutate()` for refetch, a real
`error` object (kills string-sniffing and silent-swallow structurally). A
hand-rolled `useFetch` would reinvent SWR badly and still need someone to
remember `AbortController` every call site. **SWR over react-query:** ~4kb,
simpler API, fits a fetch-only use case — no mutation/optimistic-update framework
needed beyond what SWR's `mutate` already gives. The only shared primitive worth
writing is one `loadFetcher` throwing a status-carrying error on non-2xx.

## Status-aware behavior (the design contract)

| Server says | Behavior |
|---|---|
| network drop / timeout / **5xx** | spinner + bounded exponential backoff auto-retry; recover silently on success; after K attempts → terminal inline "Couldn't load — retry" |
| **401** (no session) | no retry → redirect to sign-in (`/`), matching `useRequireRole` |
| **403** (authenticated, not allowed) | no retry → inline access gate |
| **404 / 400** | no retry → inline terminal "not found" / "bad request" (distinct copy) |

## Decisions (resolved with the product owner — the fixed points)

1. **`revalidateOnFocus: false`** globally — the app has never auto-refetched on
   tab focus; SWR's default-on would silently re-hit sensitive endpoints.
   **`revalidateOnReconnect: true`** — this *is* the "recover silently when the
   server returns" path.
2. **Retry: K = 4** (5 attempts total), backoff starts at 2s, ×2, 30s cap, then
   the terminal card. `shouldRetryOnError` stays globally true; the per-status
   stop lives inside `onErrorRetry` (401/403/404/400 never retry).
3. **No-retry exceptions** (per-hook `shouldRetryOnError:false`): the GitHub
   public API in `SystemVersionBox` (unauthenticated ~60 req/hr — retry storms
   burn it) and `merge` scoring (3 sequential fetches per attempt — retrying
   multiplies cost). **Idempotency is *not* a reason to skip retry elsewhere** —
   see the constraint below.
4. **Auth:** loaders are same-origin `fetch`, so the NextAuth session cookie
   rides automatically — the fetcher needs nothing for session auth. Exception:
   the two kiosk pages (`attendance/current`, `attendance/certifications`) add
   `x-kiosk-signature/-timestamp/-nonce` headers via an array key `[url,{headers}]`.
5. **401 vs 403 split.** 401 → redirect to `/` (session is gone; a dead-end card
   would be wrong), done in a `useEffect` mirroring `useRequireRole` so
   navigation never happens inside the fetcher. 403 → inline access gate
   (redirecting a logged-in user is pointless). `useRequireRole` stays the coarse
   pre-fetch redirect; the inline gate is defense-in-depth for when the two
   disagree.
6. **`retrying` tracked explicitly** via an attempt counter, not derived from
   `isValidating`, so the spinner doesn't flicker to "terminal" during the
   backoff gap.
7. **`dedupingInterval: 5000`** (up from 2000) — pages share keys (`/api/roles`,
   `/api/household`), so bouncing between them reuses one response.
8. **No RSC/Suspense.** Every in-scope loader is a `"use client"` component; do
   **not** enable SWR `suspense: true` — keep the loading-flag return shape.

## Constraints backing the decisions

- **Retrying GET loads is correctness-safe app-wide.** Verified: the only `GET`
  handler that writes is `admin/settings/localization` doing a settings-singleton
  `upsert({where:{id:1}, create:DEFAULTS, update:{}})` — a no-op on an existing
  row, safe to retry any number of times, and not even a migrated loader. Backs
  Decision #3.
- **The inline 403 gate is genuinely defense-in-depth.** Where the client
  `useRequireRole` gate and the server `withAuth` rule agree, the server never
  sees an unauthorized request and the gate never fires. It fires only when the
  client gate is *broader* than the server rule (e.g. `useRequireRole([])` on
  `program-ops/programs/[id]` vs. that route's per-household check) or on a
  truly public page, plus 401 session-expiry mid-session. Backs Decision #5.

## Still open (verified still open)

- **Is `SystemVersionBox` querying GitHub live the right design at all?** It
  still hits `api.github.com/.../commits/main` and `.../compare/...` on mount
  (confirmed in `SystemHealthPanels.tsx`), unauthenticated and rate-limited. Live
  client call vs. cached/server value is a pre-existing question, out of scope
  for this migration; it migrates as-is with `shouldRetryOnError:false`. A
  follow-up was spun off — check whether it still queries GitHub live before
  re-raising.

## Sequencing (strategy, not a per-file plan)

Foundation first — `loadFetcher` (+ `classify`/`onErrorRetry` unit test),
`LoadStates` UI (`TerminalState`, `AccessGate`; `PageLoader` already exists),
`useLoad`, then `<SWRConfig>` into the existing client `AuthProvider` — nothing
migrates until these land. Then loaders in risk-ascending batches, each its own
PR: simple transient → `useRequireRole`-gated → 403-gate → 404-terminal → admin
panels → dependent/heavy (`merge`) → kiosk pollers last (each needs its own
mini-design). `<SWRConfig>` is additive context, so migrated and unmigrated pages
coexist and the rollout is fully incremental. `programs/[id]/register` is blocked
on a separate auth-first redesign — check whether that shipped before treating it
as blocked.
