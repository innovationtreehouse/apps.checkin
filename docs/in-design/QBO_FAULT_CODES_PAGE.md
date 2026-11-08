# QuickBooks fault codes page

## Problem

When QuickBooks refuses an entry, it answers with a numbered fault code. The app
knows what one code means (closed books); every other code it sorts by a fixed
rule. Today nobody can see which codes QuickBooks has actually sent us, how often,
or how the app sorted each one. The only record is a log line that finance cannot
read. So finance, who hold QuickBooks, can't check that a code we treat as "this
item's data is wrong" isn't really a books-map setting, and the people who maintain
the code table have nothing to work from.

## Objective

One page lists every QuickBooks fault code the app has received, with a pill for
the kind each was sorted as, how many times, and when it was first and last seen.
The page reads live rows, so a code seen this morning is on it this morning.

## Executive summary

- **Finance, the board and sysadmins** see one page, under System Status.
- **Stored:** one small row per code and kind, holding only the code, the kind, a
  count, first and last seen, and a lane name. Rows are kept, not pruned.
- **Recorded** by the host's binding of each library's "on failure" port, which
  already receives every kinded failure with its fault codes. No lane's behaviour
  changes, and a failed write never fails the lane.
- **Unchanged:** how a code is sorted, the run-level rule (three refusals with one
  code in a run stop it as a setting), and what finance is told about a held item.
- **Cost:** one new table, one route, one page, and a registry entry that
  ships alone first.

## Rules this relies on

- Finance holds QuickBooks. A QuickBooks refusal the app can't settle goes to
  finance (`docs/architecture/RECEIPT_PIPELINE.md`, posting lanes;
  `docs/rules/revenue.md`, gifts of goods).
- QuickBooks fault text is never logged or stored; codes and request ids are.
- Least privilege (`docs/rules/principles.md`): a surface grants nothing its gate
  does not already grant.

## Design

### What is stored

A new host table, `QboFaultCodeSeen`, one row per code and kind:

| Column | Type | Tier | Meaning |
|---|---|---|---|
| `code` | text | internal | The fault code, as QuickBooks sent it ("6000") |
| `kind` | text | internal | The kind the report carried: system, connection, settings, data or bug |
| `count` | int | internal | Reports carrying this code with this kind |
| `firstSeenAt` | timestamp | internal | First report |
| `lastSeenAt` | timestamp | internal | Latest report |
| `lastLane` | text | internal | Library and lane of the latest report ("expense posting") |

Primary key `(code, kind)`. A report carrying two codes counts toward each, the same
way the run-level rule counts them.

A row per kind, not per code, because one code can arrive under different statuses:
a 401 with a code is connection, a 400 with the same code is data. The page shows
each.

Those six columns are the whole row. It holds no detail text, no fault text, no
request id, no item id, no amount and no name of a person, vendor or donor. The
report's request id and detail stay where they already are: the log line and the
held item. This limit is the basis for sysadmin access (below), so a later column
outside it is an access change, not a schema tweak.

**Retention.** Rows are never pruned. The set is bounded by the codes QuickBooks
uses times five kinds, so a few dozen rows, and an old code's last-seen date is
itself useful.

### How it is recorded

Each library's runtime already hands every kinded failure to its "on failure" port,
fire-and-forget. The host binds that port per library (`reportTo` in
`checkin-app/src/lib/finishRun.ts`). For a report that carries
fault codes and comes from a QuickBooks lane, the binding upserts one row per code:

```sql
INSERT INTO "QboFaultCodeSeen" ("code", "kind", "count", "firstSeenAt", "lastSeenAt", "lastLane")
VALUES ($1, $2, 1, now(), now(), $3)
ON CONFLICT ("code", "kind") DO UPDATE
  SET "count" = "QboFaultCodeSeen"."count" + 1, "lastSeenAt" = now(), "lastLane" = EXCLUDED."lastLane";
```

The writer is `recordFaultCodes` in `checkin-app/src/lib/qboFaultCodes.ts`, a Prisma
upsert of that shape.

The write runs outside the lane's transaction, on the shared client. A failed write
is logged and dropped, never thrown, so a lane's retry and settle never depend on
it. Counts can therefore undercount during a database outage; the log line remains
the full record.

The QuickBooks lanes are the binding's list: expense posting, gift posting and
income deposit build, the lanes `finishRun.ts` groups under the `quickbooks` cause.
All three report their failures through `failed()`, so all three feed the table.
Only QuickBooks errors carry fault codes today, but the list keeps a future
service's codes off this page.

### Who sees the page

| Role | Why |
|---|---|
| Finance | Holds QuickBooks; decides whether a code is the item's data or a books setting |
| Board | Ruled in (FC1) |
| Sysadmin | Maintains the code table in the QuickBooks package and the sorting rules |

The page shows only what the row holds: codes, kinds, counts, dates and lane
names. With no amount, detail, request id or name on it, a sysadmin reading it
gains no finance access, and the read is not an audited finance view.

### Route and registry entry

`GET /api/quickbooks/fault-codes`, under `handler()`, returns every row ordered by
last seen, newest first. No paging; the set is small.

The registry entry ships in its own boundary PR, after the table exists and before
the route:

```ts
// QuickBooks fault codes seen: code, kind, count, dates, last lane. No finance
// content, so sysadmins read it too, and it is not an audited read.
defineRoute({
    endpoint: 'GET /api/quickbooks/fault-codes',
    authorize: { anyRole: ['isFinance', 'isBoardMember', 'isSysadmin'] },
    envelope: 'codes',
    returns: ['QboFaultCodeSeen'],
    orderedView: [
        ['isFinance',     ['everyones:internal', 'public']],
        ['isBoardMember', ['everyones:internal', 'public']],
        ['isSysadmin',    ['everyones:internal', 'public']],
    ],
});
```

### How the page reads

One page, `/system-status/qbo-codes`, a "QuickBooks codes" tab in the System
Status strip, added to the page registry.

System Status is sysadmin and board today, so finance is admitted to this tab only:

- The section becomes visible to finance too; every existing tab gets a sysadmin
  or board gate of its own, so finance's strip shows this one tab.
- The System Status layout admits finance on this path only, as it already admits
  keyholders on Unsynced Scans.

A line at the top: "Every fault code QuickBooks has sent us, and how the app sorted
it. A code marked unclassified is treated as the item's data, unless three items in
one run are refused with it."

Then a table, one row per code:

| Code | Classified as | Sorted as | Seen | First seen | Last seen | Last lane |
|---|---|---|---|---|---|---|
| 6000 | `unclassified` | `data 14` `connection 1` | 15 | 3 Nov | today 09:12 | expense posting |
| 6190 | `unclassified` | `data 2` | 2 | 5 Nov | 6 Nov | gift posting |

- **Classified as** comes from the code table, `FAULT_CODES` in
  `packages/quickbooks/src/faultCodes.ts`, which maps a fault code to settings, data
  or closed books. The same file's `faultKind` sorts every QuickBooks refusal from
  it, so the page and the sorting read one table. A code not in the table reads
  `unclassified`. Its one entry is 6210, closed books, which the page leaves off
  (FC2), so every code reads unclassified until a settings or data entry lands by
  PR (FC3). The panel imports the table, so the response carries only stored rows.
- **Sorted as** has one pill per kind with its count, in the kind colours the rest
  of the app uses.
- The panel refreshes on focus and every minute. Empty, it says "QuickBooks hasn't
  refused anything yet."

## Rollout

Three PRs, in order. None is stacked on another.

1. **Table and writer.** Migration adds the table (additive, safe against old code).
   The host's on-failure binding writes it. Tests: the upsert, two codes counting
   toward each, a non-QuickBooks lane ignored, a failed write not thrown.
   Builds on the host's on-failure binding.
2. **Registry entry**, alone (boundary PR).
3. **Route and page**, with the System Status nav changes and the page-registry entry.

## Open questions

None. Every question is ruled; see Rulings.

## Rulings

| Q | Ruling |
|---|---|
| FC1. Who sees the page | Sysadmins, finance and the board, under System Status. Sysadmin access rests on the row holding only code, kind, counts, first and last seen, and lane names. |
| FC2. Closed books (fault 6210) | Left off the page. Books close once a year, so it is rare, and it already ends as "Not booked" for finance. |
| FC3. Reclassifying from the page | No. The code table stays in the QuickBooks package, edited by a PR with a test per entry. The page only reads it. |
| FC4. Counts after a reclassification | No reset. Counts keep running across a change to the code table; the last-seen date shows recent activity. |
