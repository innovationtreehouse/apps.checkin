# Paged lists keep their page in the URL

Survey and decisions for making every paged list in the app keep its page in
the address bar.

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
  whatever filter the screen happens to start with. Q1 settles it: filters,
  view tabs and sort go in the URL with the page. Typed search text does not
  (Q2).
- **The build is one PR:** the shared helper in `@checkin/component-ui`, every
  list moved onto it, and the convention. The finance view log design's open
  point closes once #3093 has added it.

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
  past 200 are silently not shown; #3151 tracks that (Q6).
- **No "Load more", infinite scroll or cursor paging** anywhere in
  `packages/*/src` or `checkin-app/src`.
- **No paging inside a modal or panel.** The modals beside L1, L4, L16 edit or
  confirm one row.

## Decisions

@thpr settled all six. The numbers are kept so the reasoning below still lines
up.

| # | Question | Decision |
|---|---|---|
| Q1 | Does the convention cover the filters, search and sort beside a pager, or only the page? | All of them: the URL holds the page, filters, view tabs and sort. A filter change drops `page`. [Decision — @thpr] |
| Q2 | Does typed search text go in the URL? | No. It stays in local state and a change resets to page 1. Selects, date pickers and toggles go in the URL. [Decision — @thpr] |
| Q3 | Push or replace, for the page and for filters? | The page pushes; filters, view tabs and sort replace. [Decision — @thpr] |
| Q4 | What does a page past the end show? | A list with a total clamps to its last page. A list without one shows the empty page with its pager. A missing, non-numeric, zero or negative `page` is page 1. [Decision — @thpr] |
| Q5 | Does `limit` go in the URL? | No. [Decision — @thpr] |
| Q6 | The five capped catalog lists: in scope? | No. Tracked in #3151, a "more rows exist" notice. [Decision — @thpr] |

The sections below are the reasoning each decision rests on.

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

Decided: out of scope here, since they do not page. #3151 tracks a "more rows
exist" notice for them.

## Proposed convention

The text added to `docs/conventions.md`, a new section after "A library's pages
share one client kit", worded to Q1–Q5.

> ## A paged list keeps its place in the URL
>
> - **A paged list keeps its page in the URL query (`page`), with the filters,
>   view tabs and sort that decide its rows.** A reload, the back button and a
>   shared link land on the same rows, and each page is its own page view in the
>   finance view log.
> - **Typed search text stays out of the URL.** It lives in the screen's state,
>   and a change starts again on page 1. Selects, date pickers and toggles go in
>   the URL.
> - **Paging pushes a history entry; a filter, view or sort change replaces the
>   entry and drops `page`.** Back steps through pages, not filter states.
> - **A bad or out-of-range `page` never shows an error.** A missing,
>   non-numeric, zero or negative `page` is page 1. A list that knows its total
>   shows its last page for a page past the end; a list without one shows the
>   empty page with its pager.
> - **`limit` stays out of the URL** while no screen lets anyone pick a page size.
> - **Read and write it with `@checkin/component-ui`'s `useUrlPage`,
>   `useUrlFilter`, `useUrlChoice` and `useSetUrlFilters`**, never `useState`
>   for the page or a filter.

## The build

One PR:

1. **The helpers**, in `@checkin/component-ui`'s `urlState.ts`, read through
   `useSearchParams` and written through the router. `useUrlPage` reads `page`,
   falls back to 1 on a missing or bad value, clamps to the last page when the
   caller passes one, and writes with `router.push` (Q3), keeping the other
   query params. `useUrlFilter` (free values such as a date or a person),
   `useUrlChoice` (a fixed set such as a view tab or sort) and
   `useSetUrlFilters` (several keys at once) write with `router.replace` and
   drop `page`. `Pager` keeps its `page` and `onChange` props; callers pass
   `useUrlPage`'s pair. Tests: reads state from the URL; a page change pushes
   and a filter change replaces; a filter change drops the page; Q4's
   fallbacks and clamping.
2. **Every list on it.** L1–L18, plus their filters under Q1. Typed search
   boxes (L12, L13, L16, and the record-id and entity-id boxes on L17, L18)
   stay in local state; a change replaces the URL without `page`.
3. **The convention** in `docs/conventions.md`.
4. **The finance view log design.** Close the PR 3 open point that #3093 adds
   (paging that does not change the URL): all paging changes the URL, so
   #3093's requirement (b), a new page-view id per URL query change, covers
   it. Doc edit only; no finance view log code. It waits for #3093 to merge,
   and this doc goes once it lands.

Host pages under `checkin-app/src/app` (L17, L18) move onto the same helper,
since nothing about their paging needs its own.
