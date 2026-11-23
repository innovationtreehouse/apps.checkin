# QuickBooks codes: a "Classified as" column

## Problem

The QuickBooks codes page shows every fault code QuickBooks has sent, and how the
app sorted each one. The app knows what one code means (closed books) and sorts
every other refusal by its HTTP status: a refused login is a connection problem, a
server error or throttle is the system's, and everything else is the item's data.
So a code that really means a books-map setting still reaches finance as "this
item's data is wrong", and the page can only show that it was sorted that way. It
can't show whether anyone has looked at the code and decided what it means.

## Objective

Each row on the page also says how the code is classified in the app's own code
table, or that it isn't classified yet. Finance can see which codes still need a
decision.

## Executive summary

- **Finance, the Board and sysadmins** see one more column, "Classified as", on the
  page they already read, and a line in the intro on unclassified codes.
- **Stored:** nothing new. The page reads the code table from the QuickBooks
  package; the route still returns only the stored rows.
- **Changes:** a code in the table is sorted by the table, overriding the status
  rule, so a settings code reaches finance as a settings problem.
- **Cost:** one table in the QuickBooks package with a test per entry, a lookup in
  the error's sorting, and one column on the page.

## Proposal

A code table in `packages/quickbooks`, beside `statusKind` in `src/client.ts`, maps
a fault code to `settings` or `data`. `QboRequestError` checks it before the status
rule. The page imports the same table and shows the entry for each code, or
"Not classified".

| Code | Sorted as | Classified as | Seen | … |
|---|---|---|---|---|
| 6000 | `data 14` `connection 1` | Not classified | 15 | … |
| 6190 | `data 2` | `settings` | 2 | … |

The table changes only by a PR, never from the page, and counts keep running across
a change to it (FC3, FC4 below).

## Open question

**Q1. Build the column and the code table?** Not decided.

- **Build it.** Codes become classified one PR at a time, as they appear on the
  page and finance says what each means.
- **Don't build it.** The page keeps showing how each code was sorted; finance
  reports a code that is sorted wrongly, and a fix changes the status rule.

## Rulings

| Q | Ruling |
|---|---|
| FC3. Reclassifying from the page | No. The code table stays in the QuickBooks package, edited by a PR with a test per entry. The page only reads it. |
| FC4. Counts after a reclassification | No reset. Counts keep running across a change to the code table; the last-seen date shows recent activity. |
