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

- **Finance and the board** get a page under the Finance tab. Sysadmins get the
  same panel under System Status.
- **Stored:** one small row per code and kind, holding a count and two dates. No
  fault text, no request ids, no item ids. Rows are kept, not pruned.
- **Recorded** by the host's binding of each library's "on failure" port, which
  already receives every kinded failure with its fault codes. No lane's behaviour
  changes, and a failed write never fails the lane.
- **Unchanged:** how a code is sorted, the run-level rule (three refusals with one
  code in a run stop it as a setting), and what finance is told about a held item.
- **Cost:** one new table, one route, two thin pages, and a registry entry that
  ships alone first.

## Rules this relies on

- Only finance has QuickBooks access; sysadmins don't. A QuickBooks problem goes to
  finance, and ops gets at most a copy. (Error-kinds design, Q1 ruling.)
- QuickBooks fault text is never logged or stored; codes and request ids are.
- Least privilege (`docs/rules/principles.md`): a surface grants nothing its gate
  does not already grant.
- Board is finance's superuser (`docs/rules/revenue.md`, Ownership).

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

**Retention.** Rows are never pruned. The set is bounded by the codes QuickBooks
uses times five kinds, so a few dozen rows, and an old code's last-seen date is
itself useful. Nothing here identifies a person, an item or an amount; the request
id and the item stay where they already are (the log line and the held item).

### How it is recorded

Each library's runtime already hands every kinded failure to its "on failure" port,
fire-and-forget. The host binds that port per library. For a report that carries
fault codes and comes from a QuickBooks lane, the binding upserts one row per code:

```sql
INSERT INTO qbo_fault_code_seen (code, kind, count, first_seen_at, last_seen_at, last_lane)
VALUES ($1, $2, 1, now(), now(), $3)
ON CONFLICT (code, kind) DO UPDATE
  SET count = qbo_fault_code_seen.count + 1, last_seen_at = now(), last_lane = EXCLUDED.last_lane;
```

The write runs outside the lane's transaction, on the shared client. A failed write
is logged and dropped, never thrown, so a lane's retry and settle never depend on
it. Counts can therefore undercount during a database outage; the log line remains
the full record.

The QuickBooks lanes are the binding's list: expense posting, gift posting and
income deposit build. Only QuickBooks errors carry fault codes today, but the list
keeps a future service's codes off this page.

### Who sees the page

| Role | Why |
|---|---|
| Finance | Holds QuickBooks; decides whether a code is the item's data or a books setting |
| Board | Finance's superuser |
| Sysadmin | Maintains the code table in the QuickBooks package and the sorting rules |

The page holds no finance content: codes, kinds, counts, dates and lane names. No
amount, vendor, donor or person. So a sysadmin reading it gains no finance access,
and the read is not an audited finance view.

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

One panel, rendered at `/finance/qbo-codes` (Finance strip, "QuickBooks codes") and
at `/system-status/qbo-codes` (System Status strip). Each page file only mounts the
panel; both are added to the page registry.

A line at the top: "Every fault code QuickBooks has sent us, and how the app sorted
it. A code marked unclassified is treated as the item's data, unless three items in
one run are refused with it."

Then a table, one row per code:

| Code | Classified as | Sorted as | Seen | First seen | Last seen | Last lane |
|---|---|---|---|---|---|---|
| 6000 | `unclassified` | `data 14` `connection 1` | 15 | 3 Nov | today 09:12 | expense posting |
| 6190 | `unclassified` | `data 2` | 2 | 5 Nov | 6 Nov | gift posting |

- **Classified as** comes from the code table in the QuickBooks package: settings,
  data, or `unclassified` when the code isn't in it. Until that table has entries,
  every code reads unclassified. The panel imports
  that table; it is a plain constant, so the response carries only stored rows.
- **Sorted as** has one pill per kind with its count, in the kind colours the rest
  of the app uses.
- The panel refreshes on focus and every minute. Empty, it says "QuickBooks hasn't
  refused anything yet."

## Rollout

Three PRs, in order. None is stacked on another.

1. **Table and writer.** Migration adds the table (additive, safe against old code).
   The host's on-failure binding writes it. Tests: the upsert, two codes counting
   toward each, a non-QuickBooks lane ignored, a failed write not thrown.
   Depends on the host binding the on-failure port, which is in flight.
2. **Registry entry**, alone (boundary PR).
3. **Route and pages**, with the nav links and page-registry entries.

## Open questions

- **FC1. Sysadmin access.** Sysadmins see the page under System Status, on the
  reasoning that it holds no finance content. Confirm, or keep it to finance and
  board?
- **FC2. Closed books on the page.** Fault 6210 (closed books) ends as "Not
  booked", not as a kinded failure, so it never reaches the port and never shows
  here. Should it be recorded too, under its own "closed books" pill?
- **FC3. Reclassifying from the page.** The code table stays in code, edited by a PR
  with a test per entry. Should finance instead mark a code settings or data on the
  page? That would make the table data, not code, and needs its own design.
- **FC4. Counts after a reclassification.** Counts keep running across a change to
  the code table. Should the page show counts since the code was last classified
  instead? Recommended: no; the last-seen date already shows recent activity.
