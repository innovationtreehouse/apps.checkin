# Finance view audit: cutover

One-time steps for moving to the finance view log. Everything here stops being
true once the copy has run. The permanent design is in
`B11_FINANCE_VIEW_AUDIT.md`.

## The donor-read copy (FV-9)

Before the finance view log exists, the app records each look at a donor as a
`DONOR_DATA_READ` row in the bulk-donation database's `WorkflowEvent` table.
The Board's new tab reads only the checkin database, so those rows are copied
once into `FinanceViewLog`. The originals stay where they are.

### Which rows

Only `DONOR_DATA_READ` rows written **before PR 2 deployed**. From PR 2 onward
the handler logs the same views itself, and until PR 4 removes the old writers
both logs receive them; copying those later rows would record each view twice
under two endpoint spellings that the repeat key cannot match. The cutoff is
PR 2's production deploy time, read from the deploy record and passed to the
script as an argument.

### How each row maps

| `FinanceViewLog` | From `WorkflowEvent` |
|---|---|
| `viewedAt` | `occurredAt` |
| `actorId` | `actorUserId` |
| `role` | null; the donor-read audit did not record it |
| `endpoint` | `payload.route` as stored. The receipt glue stored the concrete path (`GET /api/receipts/abc`) rather than the registry key, and it is kept as-is rather than guessed back. |
| `params` | `{}` |
| `recordIds` | `[entityId]` when set; otherwise `payload.ids` |
| `rowCount` | `payload.count` when set; otherwise the number of record ids |
| `window`, `viewKey` | computed by the same writer function the handler uses |

A row with no `actorUserId` cannot say who looked. It is not copied; the script
reports how many it skipped, and they stay readable in the original table.

### Running it

1. PR 4 ships the script with its tests. It reads the bulk-donation database
   and writes the checkin database in batches, through the shared writer, with
   the insert's `ON CONFLICT DO NOTHING`. A rerun therefore adds nothing.
2. After PR 4 deploys, run it once in production with the PR 2 cutoff.
3. Check: the copied count plus the skipped count equals the number of
   `DONOR_DATA_READ` rows before the cutoff. Record both numbers on PR 4.
4. Delete the script in a follow-up PR, and delete this file with the design
   doc when the last PR merges.
