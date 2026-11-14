# Cutover: a saved copy of the QuickBooks lists

This file holds the one-time part of `QUICKBOOKS_LIST_CACHE.md`: the order of
the PRs, what each one must be safe against, and where its rules land.
Everything here stops being true once the last PR merges. The last step is
"extract the rules, delete both files".

## Where it stands

- Designed, not built. The owner has settled every question, QL-1 to QL-7.
- Today, no account-type refusal carries a code. `accountTypeRefusal` returns
  only a message, and none of its throw sites pass a code. The client kit's
  fetch helper doesn't hand `code` to pages.
- Today, nothing re-checks these picks once they are saved: the expense
  account list and rules, held expense lines, the donation account map and
  income items. The picks row closes that gap.
- A planned interim fix runs the account-type check only when the account
  changes. It is consistent with the design and can land before any PR here.
  It also lets edits that don't touch the account skip the copy.

## Order

Every PR is based on `main`; none is stacked.

1. **Boundary.** The two registry entries and `QuickBooksListsStatus`
   (design §5). They do nothing until the routes exist, so this PR can open
   straight away.
2. **The copy.** It includes:
   - the table and its migration;
   - `refreshQuickBooksLists`, and the daily step in `qbo-posting` with its
     `quickbooks lists-refresh` lane in `finishRun.ts` (design §3);
   - the switch of `listQuickBooksAccounts`, `listQuickBooksClasses` and
     income's Class check on save over to the copy;
   - the `quickbooks-list-stale` refusal: the `QUICKBOOKS_LIST_STALE` constant,
     the code at the five throw sites, and income's Class check (design §4).

   It doesn't depend on PR 1, so the two can run in parallel.
3. **Update now.** The two routes, the `QuickBooksListsRefresh` button in
   `@checkin/component-ui`, the client kit change that hands `code` to pages,
   the button on the Books map and on the eight picker screens (design §3), and
   the "QuickBooks lists" System Status row. It goes after PRs 1 and 2 merge.
4. **The picks row.** Each library's `misTypedQuickBooksPicks` read and the
   "QuickBooks picks: account types" System Status row (design §4). It reads
   the copy, so it goes after PR 2 merges. It needs nothing from PRs 1 or 3, so
   it can run in parallel with PR 3.

## What each step must be safe against

- **PR 2's migration** only creates a table. Old code still serving traffic
  during the deploy drain never reads it.
- **PR 2 before PR 3.** Once PR 2 deploys, saves read only the copy, and the
  refusal names "Update now" before any page shows the button. The daily run is
  the only refresh in that gap. Merge PR 3 soon after PR 2, or hold PR 2 until
  PR 3 is ready.
- **The first deploy of PR 2.** The table starts empty, so every save that
  needs the copy is refused until the first refresh. Before PR 3 there is no
  button, so the next daily run is the first refresh. Deploy PR 2 the day
  before finance expects to edit setup screens, or ship it together with PR 3
  and press "Update now" once after rollout.

## Rules to extract

PR 2 extracts the design's "Rules this design establishes" into `docs/rules/`:

- **Rule 1** replaces the bulk-import deliberate limit in
  `docs/rules/expenses.md`, the line that begins "An expense line's account
  comes from finance's own mapping rules".
- **Rule 2** replaces these words in the account-types line in
  `docs/rules/revenue.md`: "reading the type from QuickBooks, and refuse the save
  while QuickBooks can't be read".
- **Rule 3** replaces this sentence in the bucket-assignment line in
  `docs/rules/revenue.md`: "While the books can't be reached to check, the
  assignment is refused".
- **Rule 4** is new. It goes in `docs/rules/revenue.md`, next to the books map
  rules.

The `docs/rules/revenue.md` line saying that a stored account that later reads
as another type is flagged on System Status keeps its wording (QL-7). When PR 4
lands, it holds for every pick (QL-7, QL-8).

After the last PR merges, delete both files.
