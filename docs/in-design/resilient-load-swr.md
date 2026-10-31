# One client loader for the app and every library

## Problem

When a page cannot reach the server for a moment, it usually shows a permanent
failure message, and that message often blames the person's permissions. Nothing
retries. A slow answer can overwrite a newer one. On some pages a failed list
looks the same as an empty one, so a person can read a failure as "nothing to
do". Library pages have one shared loader that handles part of this; app pages
each write their own, about a hundred times over.

## Objective

Every page in the app and every library loads and writes through one small kit.
A brief outage recovers without anyone acting. A page reports what the server
actually said. A new page gets all of this by calling one hook.

## Summary

- **No new package.** `@checkin/component-ui` is that kit already: every library
  uses it since #2682, and the app depends on it. This design adds SWR inside it
  and moves the app onto it.
- **Libraries change least.** All 73 library `useLoad` calls go through one
  function, so one PR gives them retry and caching with no page edits. Only
  `global-catalog` needs a real migration.
- **The app changes most.** 93 UI files call `fetch` directly and 60 of them are
  pages. They move in batches by area.
- **People will see** automatic retries, a redirect to sign-in when a session
  ends, and last-seen data for a moment on returning to a page.
- **Unchanged:** route responses, server gates, `useRequireRole`, `useViewer`,
  and the shape of `api()`.
- **A failed load stays inline.** The owner ruled this: the page shows `LoadError`
  in place of its content, as `docs/conventions.md` requires.

Standing text this relies on, in `docs/conventions.md`: "A library's pages share
one client kit", "A library names its failures; the host renders them", and "A
check that costs money is not a health check".

## What the kit exports

| Export | Today | After |
|---|---|---|
| `createClient(base)` | `{ api, useLoad }` | Same |
| `useLoad(path, options?)` | `useEffect` with a sequence guard | SWR. Second argument becomes `{ retry?: boolean }` |
| `Loaded<T>` | `data`, `error`, `reload` | Adds `loading`, `retrying`, `status` |
| `request`, `api` | Throw `Error(message)` | Throw `HttpError(message, status)`, still an `Error` with the same text |
| `ViewerProvider` | `viewer` | Adds `onSessionExpired`; clears the cache when the person changes |
| `LoadError`, `Pager`, `paged`, `lastPage`, `notifyNavCounts`, `useViewer` | | Unchanged |
| `showSuccess`, `showError`, `clearError` | | Added by the message convention's first PR, not here |

The additions are optional fields, so the 38 test files that mock a library's
`components/api` keep working.

## How a library and the app use it

A library binds its route base, as it does now, and imports nothing from the app:

```ts
export const { api, useLoad } = createClient("/api/expense");
```

The app binds the same function once. App pages already write full `/api/...`
paths, which `api()` uses as given:

```ts
export const { api, useLoad } = createClient("/api");
```

`swr` is a dependency of `component-ui` alone. No page imports it, so replacing
it later touches one file. The options sit in `useLoad` rather than a `SWRConfig`
at the root, so a page rendered in a test or outside the host behaves the same.

`AuthProvider` already mounts `ViewerProvider`, so the one host-specific behaviour
goes there as a prop. The kit never imports `next-auth` or the router.

## How it behaves

| Server says | Behaviour |
|---|---|
| Network failure or 5xx | Retry at 2s, 4s, 8s, 16s (5 attempts, 30s cap), `retrying` true and `error` null, including in a hidden or offline tab. Recover without a message. After the last attempt, `error` is set |
| 401 | No retry. Call `onSessionExpired`; the host does a full page load of `/` unless already there |
| 403 | No retry. `status` 403, so the page can show access denied in place of its content |
| 404, 400, other 4xx | No retry. `error` carries the route's own words |
| 200 with a non-JSON body | No retry. `error` set, as today |

`/api` is exempt from the middleware's redirects and routes answer 401 as JSON,
so a lost session reaches the client as a real 401, on writes as well. A failed
write is not redirected; it reports its failure like any other (message
convention) and the form stays filled in.

Settings carried over from the earlier design, already ruled on:
`revalidateOnFocus: false`, since the app has never refetched on tab focus and
the default would re-hit sensitive routes; `revalidateOnReconnect: true`, which
is the silent recovery path; `dedupingInterval: 5000`; no `suspense`.

### Five things SWR gets wrong unless told

1. **The key is the resolved URL, not the path.** The cache is shared, and two
   libraries can both have a `/settings`. A path key would show one library's
   rows on another's page.
2. **An empty path must still load.** SWR treats an empty key as "don't fetch".
   The expense finance queue's All tab has an empty path, and skipping it left
   that tab blank during #2682. Resolving to the URL first fixes this too, since
   `/api/expense` is not empty. Only `null` skips.
3. **Keep the old rows when the path changes.** Today's hook leaves `data` in
   place until the new answer arrives, and pagers and search boxes rely on it.
   SWR clears unless `keepPreviousData` is set. `undefined` also maps to `null`.
4. **A person's data does not outlive them.** The cache is in memory for the life
   of the tab. When the viewer's id changes from one person to another or to
   nobody, `ViewerProvider` empties it before paint. The viewer is also null while
   the session loads, so a move from null to a person does not count, or every
   page load would fetch twice.
5. **Tests share a cache.** A test that renders a page twice with different
   `fetch` mocks would get the first answer. The kit PR empties the cache after
   each test in `jest.setup.js` and in `component-ui`'s own setup.

### Writes

SWR does not manage writes here. Writes stay plain `api()` calls with the existing
per-library `send` helpers and `reload()`.

**Any successful non-GET through `request` revalidates every cached key**, with
one call to SWR's global `mutate` inside `request`. Nobody has to remember which
lists a write affects, which is the arrangement the conventions doc warns about.
The cost is one extra GET per loader on screen after each write, and two for a
loader whose page also calls `reload()`, which is redundant but harmless. A key
with no mounted page refetches when next opened, even inside the five-second
dedupe window; a test pins this.

A loop of writes passes `invalidate: false` on each and calls `invalidateLoads`
once when it ends, however it ends. The mail page's Release All is the one use,
because each re-read of its held list writes an audit row per item.

Reads that write an audit row (`auditedRead` routes and the held mail list) log
each re-read, so those logs grow with invalidation. The owner accepted this, since
each re-read is shown to the person.

A write made with a raw `fetch` does not invalidate. That is one more reason the
app's writes move too, and until they do, a library list opened within five
seconds of an app write can be stale until its next load.

### Reads that must not repeat

`useLoad(path, { retry: false })` opts out of retry. Two known uses: the public
GitHub calls in `SystemVersionBox` (rate limited) and `merge` scoring (three
fetches per attempt).

A read billed per wake stays behind a button and outside `useLoad`, as the
conventions doc already requires. Each app batch checks this for its pages.
`SystemHealthPanels`, `MatchAuditPanel`, `finance-ops/payments` and `programs` all
mention the database wake or the store mirror, so read those first.

Retries assume GET routes do not write, and reading them bears this out: no GET
that a page loads changes business state. Four settings routes upsert their
singleton with no update and `system-status/links` purges old rows, which are safe
to repeat. `attendance`, `programs` and `shop/tools` log a row on a 500, so a
retried failure logs up to five; their app batch should know this.

## The seven libraries

Since #2682 the copies are gone. `components/api.ts` fell from 724 lines to 358
across the seven, and what remains is mostly row types, label tables and role
hooks. The one-line difference between expense and receipt was `if (!path)` against
`if (path === null)`, and the kit took the second, which item 2 above depends on.

| Difference | Where | Outcome |
|---|---|---|
| No `useLoad`: 39 `api()` calls, 7 `useEffect`s, a local `latestGate` | `global-catalog` | Real migration; delete `latestGate` |
| Second loader `catalogApi` | `workflow-mapping` | Delete. Its three callers pass `/api/catalog/...`, which `api()` accepts. This is the only use of `useLoad`'s old second argument |
| `send(path, method, body, success)` | `expense` | Keep; failure moves to `showError` with the message convention |
| `send(..., success, failed)`, titled failure | `receipt` | Same |
| `act(call, ok, reload)`, multi-line failure styling, no nav refresh | `bulk-donation` | Same. Its long message is the case the convention says to check in a browser |
| `useCatalogNames`: one read per GTIN, failures ignored on purpose | `local-inventory` | Keep. It has no single key, and a missing name is not a failure |
| Raw `fetch` write `releaseOne` | `receipt/pages/mail` | Change to `api()` with `invalidate: false`; `releaseAll` invalidates once at its end |
| Raw `fetch` for a text file | `receipt/ReceiptFile` | Keep. The body is not JSON |
| `upload` with a form body | `receipt` | Keep; `request` already handles forms |
| `goTo`, a full page load | `expense` | Keep |
| Hand-written load failure, no `LoadError` | `receipt`, `workflow-mapping` | Moves to `LoadError`, in its own PR |
| Floating load failure, `useLoadFailedChip` | `expense/financeQueue` | Moves to `LoadError`, in its own PR |
| Role hooks: `useRoles` ×2, `useCanManage` ×3, `useIsFinance`, `useCanWrite` | Various | Keep. Each mirrors its own routes' gate in one line |

## PR sequence

Each is its own PR, based on `main`.

1. **Kit.** SWR inside `useLoad`, `HttpError`, the new `Loaded` fields,
   invalidation in `request`, the `ViewerProvider` additions, the
   `workflow-mapping` and `receipt/mail` fixes, test setup. Tests in
   `component-ui` for each row of the behaviour table and each of the five items
   above, which needs `jsdom` and `@testing-library/react` as dev dependencies
   there. All library pages change behaviour here, and one revert undoes it.
2. **`global-catalog`** onto `useLoad`.
3. **App binding, then app batches by area**, lowest risk first: simple loaders,
   `useRequireRole` pages, admin panels, `merge` and other heavy pages. Each batch
   replaces its `fetch`, `res.json().catch(...)` and `data.error ||` handling, and
   its failure display moves to `LoadError`. Kiosk pages come last with their own short
   design, since their signed headers change per request.
4. **Page splits**, one page per PR and never inside a loader PR, so a reviewer
   can tell a behaviour change from a move. Pick by size once the loaders are out,
   since that removes much of the bulk.
5. **Library load failures onto `LoadError`:** `receipt`, `workflow-mapping` and
   `expense/financeQueue`.
6. **Lint rule and convention.** Ban `fetch` in UI files outside the kit, with the
   text-file exception and excluding the three server-side files that call it
   (`lib/membership/contract/zohoClient.ts`, `lib/shopify/client.ts`,
   `lib/shopify/products.ts`), and extend "A library's pages share one client kit" in
   `docs/conventions.md` to the app. Then delete this doc and the `PL9` line in
   `docs/backlog/INDEX.md`.

The message convention's helpers can land before or after step 1; neither needs
the other.

## Decisions

The owner ruled on these.

- **Every library switches at once.** The first PR changes all 73 library calls,
  on pages it does not touch. That means one engine and one revert; a flag on
  `createClient` would mean two engines for weeks and no shared cache.
- **A returning page shows last-seen data, then the fresh answer.** A person may
  see an old row for the length of one request, and the server still decides any
  write. Back-navigation is instant, and a person's own writes invalidate.
- **A session that ends during a load redirects, on every page.** Library pages
  show an "Unauthorized" failure today, so this is new for them. Text typed into
  a form is lost if a background load triggers the redirect, though saving that
  form would have failed too.
- **A failed page load stays inline,** using `LoadError` in place of the content.
- **The app migration covers all 93 files, loads and writes.** Invalidation and
  the lint rule both need every write to go through the kit.

## Alternatives rejected

- **A new `@checkin/client-kit` package.** It would hold what `component-ui`
  already holds, and every library would have to change its imports.
- **react-query.** Its mutation framework is what we don't need, and it is larger.
- **Keeping the hand-written hook and adding retry to it.** It leaves request
  dedupe, cache and reconnect to write and test ourselves.

## Appendix: counts

Grep on `main`, excluding tests and `app/api`. Counts drift, so re-grep before
scoping a batch. App UI files: 98 with `useEffect`, 93 with `fetch`; 97 lines with
`.json().catch((`, 78 with `data.error ||`.

| Library | `useLoad` | `api()` in UI | `useEffect` | `LoadError` |
|---|---:|---:|---:|---:|
| `bulk-donation` | 14 | 16 | 1 | 12 |
| `expense` | 21 | 2 | 3 | 6 |
| `global-catalog` | 0 | 39 | 7 | 10 |
| `income` | 8 | 3 | 0 | 5 |
| `local-inventory` | 12 | 11 | 3 | 8 |
| `receipt` | 12 | 3 | 6 | 0 |
| `workflow-mapping` | 6 | 4 | 2 | 0 |

Tracking issue: #1308. Backlog item: `PL9`.
