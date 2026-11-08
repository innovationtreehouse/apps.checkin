# Paged lists keep their page in the URL

Survey and open questions for making every paged list in the app keep its page
in the address bar. No code changes with this doc.

## The problem

On most paged lists in the app, the page you are on lives only in the screen's
memory. Reload, press back after opening a row, or send someone the link, and
you land on page 1. On a long list you then page forward again to find your
place.

It also blurs the finance view log. That log is designed to write one entry per
page view, and a page view starts on each in-app navigation, a change of URL
query included. Moving to the next page is meant to be a new page view. Where
the page lives only in memory, the browser cannot tell "next page" apart from
the rest of the same page view. The log's design leaves that case as an open
point for its browser half. The open point is added by the design's first build
PR (innovationtreehouse/apps.checkin#3093, still open), not by the design on
`main`, so this doc depends on that PR merging.

## Objective

Every paged list keeps its page in the URL query (`?page=2`). A reload, the
back button and a shared link land on the same page, and each page is its own
page view in the finance view log. The rule is written down as a convention in
`docs/conventions.md`.

## Executive summary

- **18 paged lists across 16 files.** One, the expense list, already keeps the
  page in the URL. The other 17 keep it in local state; two of those, the
  inventory log's views, keep their view and filter in the URL but not the page. No list is cursor-based or infinite-scroll,
  and none pages inside a modal or side panel.
- **Every list route already reads `page` from the query**, so the change is
  in the browser only.
- **Six lists keep their filters, search or sort in local state beside the
  pager.** Putting only the page in the URL would make `?page=3` mean page 3 of
  whatever filter the screen happens to start with. That is the main question
  below (Q1), and it pulls in Q2 (search text in the URL) and Q3 (history
  entries).
- **Nothing is built until the questions are settled.** The build is one PR:
  the shared helper in `@checkin/component-ui`, every list moved onto it, the
  convention, and the finance view log design's open point closed once #3093
  has added it.

## Rules this relies on or changes

- `docs/conventions.md`, "A library's pages share one client kit": package UIs
  take `Pager` and paging from `@checkin/component-ui`. The new helper lives
  there, so this extends that rule rather than adding a second paging kit.
- The finance view log design (`docs/in-design/FINANCE_VIEW_RECORD_IDS.md`, with
  the requirement and open point that innovationtreehouse/apps.checkin#3093
  adds to it): a URL query change mints a new page-view id. Not yet a standing
  rule, and not on `main` until #3093 merges; this doc depends on it only for
  the motivation and for build step 4.
- New: the convention this work adds (draft wording under "Proposed
  convention").

## Survey

"URL" means the page number is read from the address bar today. "Route reads
page" means the list's API route already takes `page` (and `limit`) from its
query. Every route does.

### Lists using the shared `Pager` (`@checkin/component-ui`)

`Pager` takes `page` and `onChange` from the caller; each caller holds `page`
in `useState(1)`. None of them has a total, so `Pager` offers one more page
when the current one is full.

| # | Route | File | Page state | Beside the pager |
|---|---|---|---|---|
| L1 | `/donations/account-map` | `packages/bulk-donation/src/pages/accountMap.tsx` | local | an edit modal (does not page) |
| L2 | `/donations/comment-rules` | `packages/bulk-donation/src/pages/commentRules.tsx` | local | nothing |
| L3 | `/donations/events` | `packages/bulk-donation/src/pages/events.tsx` | local | nothing |
| L4 | `/donations/holds` | `packages/bulk-donation/src/pages/holds.tsx` | local | a confirm modal (does not page) |
| L5 | `/donations/in-kind-gifts` | `packages/bulk-donation/src/pages/manualInKind.tsx` | local | the entry form above the list |
| L6 | `/donations/transactions` | `packages/bulk-donation/src/pages/transactions.tsx` | local | **All / Assigned / Unassigned filter, local**; a change resets to page 1 |
| L7 | `/donations/unassigned` | `packages/bulk-donation/src/pages/unassigned.tsx` | local | per-row picks, local |
| L8 | `/donations/uploads` | `packages/bulk-donation/src/pages/uploads.tsx` | local | the upload form |
| L9 | `/expense/account-mapping` | `packages/expense/src/pages/accountMapping.tsx` | local | the add form |
| L10 | `/expense/ownership-map` | `packages/expense/src/pages/ownershipMap.tsx` | local | the add form |

### Package lists using Mantine `Pagination` directly

These have a count route, so they know the last page.

| # | Route | File | Page state | Beside the pager |
|---|---|---|---|---|
| L11 | every route mounting `ExpenseList` (via `checkin-app/src/components/expense/ExpenseActionList.tsx`) | `packages/expense/src/pages/expenses.tsx` | **URL** (`view`, `page`, `active`), `router.replace` | view and active filter, both in the URL |
| L12 | `/inventory/org-items` | `packages/local-inventory/src/pages/orgItems.tsx` | local | **search and sort, local**; either resets to page 1 |
| L13 | `/inventory/unlocated` | same file, `UnlocatedItemsPage` | local | **search and sort, local** |
| L14 | `/inventory/inventory-log`, "By part" view | `packages/local-inventory/src/pages/inventoryLog.tsx` | local | view and receipt filter in the URL, `router.replace` |
| L15 | `/inventory/inventory-log`, "By receipt or donation" view | same file | local | view and status filter in the URL, `router.replace` |
| L16 | the global catalog items page | `packages/global-catalog/src/components/GlobalInventoryClient.tsx` | local, clamped to the last page | **search, show-archived and sort, local** |

### Host pages under `checkin-app/src/app`

| # | Route | File | Page state | Beside the pager |
|---|---|---|---|---|
| L17 | `/system-status/finance-views` | `checkin-app/src/app/system-status/finance-views/page.tsx` | local; fetches one extra row to know a next page exists | **person, kind, record id, from, to filters, local**; a change resets to page 1 |
| L18 | `/system-status/audit-log` | `checkin-app/src/components/admin/AuditLogPanel.tsx` | local | **action, table, actor, entity id, from, to filters, local**; a change resets to page 1 |

### Not counted

- **Five capped lists in the global catalog** (`ReferenceConflictsClient`,
  `ConversionChallengesClient`, `ItemReferenceProposalsClient`,
  `ProvisionalProposalsClient`, `LearnedReferencesClient` under
  `packages/global-catalog/src/components/`) fetch `page=1&limit=200` and show
  no pager. They are not paged, so the convention does not reach them. Rows
  past 200 are silently not shown; that is a separate question (Q6).
- **No "Load more", infinite scroll or cursor paging** anywhere in
  `packages/*/src` or `checkin-app/src`.
- **No paging inside a modal or panel.** The modals beside L1, L4, L16 edit or
  confirm one row.

## Questions for @thpr

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does the convention cover the filters, search and sort beside a pager, or only the page? | Filters and sort: yes. Search text: see Q2. |
| Q2 | Does typed search text go in the URL? | No for now; it stays in local state and resets the page. |
| Q3 | Push or replace, for the page and for filters? | Page: push. Filters and sort: replace. |
| Q4 | What does a page past the end show? | The last page, where the list knows its total; otherwise the empty page with its pager. |
| Q5 | Does `limit` go in the URL? | No. No screen lets anyone change it. |
| Q6 | The five capped catalog lists: in scope? | No. A follow-up issue. |

### Q1. Page only, or the filters beside it too?

Six lists (L6, L12, L13, L16, L17, L18) hold filters,
search or sort in local state next to the pager. If only the page moves to the
URL, the page number stops meaning one thing. Example, the gift list (L6):

1. Pick "Unassigned", page to 3. The URL reads `/donations/transactions?page=3`.
2. Open a gift, press back. The filter comes back as "All" (its default), the
   page as 3. You are on page 3 of every gift, not of the unassigned ones.

The same on the finance view log (L17): filter to one person, page to 2, reload,
and you see page 2 of everyone's views.

The lists that already use the URL put their filters there. The expense list
(L11) keeps view, filter and page there, which is why back works on it today.
The inventory log (L14–L15) keeps view and filter there but not the page, so
back from a log entry keeps the filter and returns to page 1.

Recommendation: the convention covers **everything that decides which rows the
list shows**: the page, filters, view tabs and sort. A filter change drops
`page` from the URL (back to page 1), as every list already does in memory.
That widens the build from the 17 lists' pages to those plus about 15 filter
and sort controls.

### Q2. Does typed search text go in the URL?

Three lists have a free-text box: L12/L13 (org items search), L16 (catalog
search), and the record-id and entity-id boxes on L17 and L18. Two things
follow from putting typed text in the URL:

- **It lands in browser history and in shared links.** The catalog search is
  part names, but the same helper would carry a donor's or vendor's name the
  day a donation list gains a search box.
- **The finance view log counts each URL change as a page view.** Typing
  "4412" in the finance view log's record box would mint up to four page views
  unless the URL write waits for typing to stop. The log design keeps
  undeclared query parameters off its rows for the same reason: a search box
  holds whatever the viewer typed.

Recommendation: search text stays in local state for now, and a search change
resets to page 1 (as today). A reload keeps the page but loses the search;
shared links never carry typed text. Selects, date pickers and toggles go in
the URL under Q1. The cost: on L16, back from an item to a searched list lands
on page 1 of the whole catalog.

### Q3. Push or replace?

Today L11 changes view, filter and page with `router.replace`, and L14–L15
change view and filter with it (their page is local state). Back leaves the
list entirely on all three.

- **Page with push.** "Next page" is a new page view in the log, and back
  should return to the page before. Example: on expenses, page 1 → 2 → 3, back
  lands on 2. Today back from page 3 leaves the expense list.
- **Filters and sort with replace.** A filter change resets the page, so a push
  per filter change makes back step through filter states nobody thinks of as
  places. It also keeps a date picker from adding one entry per click.

On L11 this changes what back does after paging; L14–L15 gain the page in
the URL for the first time. Recommendation:
push for the page, replace for everything else. The alternative is push for
both, which gives one back step per filter change.

### Q4. What does a page past the end show?

A shared link outlives the list: `?page=9` on a list now three pages long.
Three behaviours are in the code today:

- L16 clamps to the last page (`clampPage` in
  `packages/global-catalog/src/components/api.ts`).
- L12–L15, L18 show an empty table with the pager still on 9.
- L1–L10 and L17 (no total) show an empty table with a pager back to 8.

A missing, non-numeric, zero or negative `page` falls back to 1; that part is
settled by the brief. Recommendation: lists with a total clamp to the last
page; lists without one show the empty page with their pager, since they cannot
know where the end is without a second request.

### Q5. Does `limit` go in the URL?

Every list uses a fixed page size (50 through `PAGE_SIZE`, or its route's own
constant for L17 and L18). No screen lets anyone pick a size. A `limit` param
would be read but never written by the app, and a hand-edited `?limit=500`
would only change what the route already allows.

Recommendation: the convention names `page` only. It adds `limit` the day a
list offers a page-size choice.

### Q6. The five capped catalog lists

The five global-catalog review queues load the first 200 rows and
show no pager or "more" notice. Example: `ProvisionalProposalsClient` fetches
`/provisional-items?page=1&limit=200`; a 201st proposal never appears.

Recommendation: out of scope here, since they do not page. File a follow-up
issue to give them the shared pager (at which point the convention covers
them).

## Proposed convention

Draft text for `docs/conventions.md`, a new section after "A library's pages
share one client kit". Its wording depends on Q1–Q3 and Q5.

> ## A paged list keeps its place in the URL
>
> - **A paged list keeps its page in the URL query (`page`), with the filters,
>   view and sort that decide its rows.** A reload, the back button and a
>   shared link land on the same rows, and each page is its own page view in the
>   finance view log. Typed search text stays out of the URL.
> - **Paging pushes a history entry; a filter, view or sort change replaces the
>   entry and drops `page`.** Back steps through pages, not filter states.
> - **Read and write it with `@checkin/component-ui`'s paging helper**, never
>   `useState` for the page.

## The build, once settled

One PR:

1. **The helper.** A hook in `@checkin/component-ui` that reads `page` from
   `useSearchParams`, falls back to 1 on a missing or bad value, and writes it
   with `router.push` (Q3), keeping the other query params. A companion for
   filter params writes with `router.replace` and drops `page`. `Pager` takes
   its page from the hook when given no `page` prop. Tests: reads the page from
   the URL; writes it on change; a missing, non-numeric, zero or negative page
   falls back to 1; a filter change drops it.
2. **Every list on it.** L1–L18, plus their filters under Q1.
3. **The convention** in `docs/conventions.md`.
4. **The finance view log design.** Close the PR 3 open point that #3093 adds
   (paging that does not change the URL): all paging changes the URL, so
   #3093's requirement (b), a new page-view id per URL query change, covers
   it. Doc edit only; no finance view log code. If #3093 has not merged when
   the build starts, this step waits for it.

Host pages under `checkin-app/src/app` (L17, L18) move onto the same helper,
since nothing about their paging needs its own.
