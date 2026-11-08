# Receipt pipeline

A receipt enters `@checkin/receipt` by upload or mail, and is read and checked until it is
finalized. `@checkin/workflow-mapping` then matches its lines to the catalog and sends it two
ways: goods to `@checkin/local-inventory`, and money to `@checkin/expense`, or to
`@checkin/bulk-donation` when the receipt records a gift of goods. Each money library runs its own
approvals and writes its own QuickBooks entry.

The libraries don't import each other. Each declares the ports it needs in its `contract.ts`, and
checkin binds those ports at boot in a `configure.ts` under `checkin-app/src/lib/`, so following
a receipt means reading a package, then the host file that connects it to the next one.

The one flag that decides the money path is the receipt's `isInKind`. The uploader sets it, at
upload or later while the receipt is open (`setInKind`); a mailed receipt starts without it.
Workflow-mapping reads it when it pushes, and nothing else chooses the route.

```mermaid
flowchart TD
    U["Upload"] --> R
    M["Mailbox, read by the daily cron"] --> R
    R["receipt: read, check, finalize"] -->|"S1 ingestReceipt"| W
    R -.->|"X13 donor, before S1"| D
    W["workflow-mapping: resolve lines, push legs"] -->|"X5, not in-kind"| E
    W -->|"X9, in-kind"| D
    W -->|"X4, catalog lines"| I["local-inventory: stock"]
    E["expense: sign-off, capital review"] -->|"poster"| QE["QuickBooks: Bill or Purchase"]
    D["bulk-donation: finance decides"] -.->|"accepted lines"| E
    D -->|"daily drain"| QD["QuickBooks: JournalEntry, or match finance's own entries"]
```

Paths below are relative to `packages/<library>/src/` and `checkin-app/src/`. S and X numbers are
the crossing names the code comments use.

| Step | Owner and file | Host connection | When it fails |
|---|---|---|---|
| Upload | receipt, `services/receiptService.ts` | `app/api/receipts/upload` | OCR failure lands in `ocr_failed`, audited as `ocr_failed:<kind>`; the uploader presses "Read it again" or types the details. An outage, a refused key or a missing key gives the call back to the daily allowance. A process that dies mid-OCR is swept there. |
| Mail | receipt, `services/mailIntake.ts` | `receiptMailbox()` in `lib/receipt/configure.ts`; `readMailbox` runs from `app/api/cron/reconcile-shopify` | An unverified sender or non-submitter is held for finance. A file over the daily limit is deferred to a later run. A mailbox that can't be listed alerts finance with its cause: lost access, Gmail not answering, no such mailbox, or an unexpected failure. |
| Check and finalize | receipt, `lib/receipt-flow.ts`, `workflows/receipt.machine.ts` | None | Holds for the submitter or finance. An error, or a receipt stuck in `uploaded`, moves to `flow_error`, which finance can restart. |
| Deliver (S1) | receipt `pushReceipt`; workflow-mapping `services/receiptIntakeService.ts` | `receiptSink` in `lib/receipt/configure.ts` | Never throws; `pushedAt` stays null. A refusal gives up at once. An outage (system, connection, settings) is never charged: the daily cron resends until delivery. A bug gives up after five failures in a row, then finance resends by hand. A gift's unsent donor (X13) holds the push back. |
| Resolve lines | workflow-mapping, `services/lineItemService.ts` | `catalogReader` in `lib/workflowMapping/configure.ts` | A failed catalog lookup leaves lines unrecognized. The receipt waits in `pending_review` until a person resolves them; the last one starts the push. |
| Push legs | workflow-mapping, `lib/apply-receipt.ts` | `expenseSink`, `donationSink`, `inventorySink` in `lib/workflowMapping/configure.ts` | A leg that succeeded is stamped and not resent. A failed leg gives `apply_failed`, which needs a person (`retry-apply`). A crashed push is swept, then gives `apply_failed`. |
| Expense intake (X5) | expense, `services/intakeService.ts` | `expenseSink` | A malformed payload, another org's, or a replay that differs from a built expense is refused back to receiving. Once the payload is stored, expense owns it and receiving's leg is applied: any failure building the expense is kept on the stored payload as failed, which the daily cron replays up to five times before giving it up for a developer (an outage, a lost connection or a missing setting uses no try, and a new arrival of the payload starts its tries from zero); a stored payload the contract no longer accepts is given up at once. Finance's queue lists it while it is failed. |
| Gift intake (X9) | bulk-donation, `inKind.ts`, `services/inKindService.ts` | `donationSink` | Written once. A replay that differs is kept out and raised for finance. |
| Gift decision | bulk-donation, `services/inKindAcceptService.ts` | `capital` in `lib/bulkDonation/configure.ts` sends accepted lines to expense | `waitingOn` names what is outstanding. |
| Expense posting | expense, `lib/expense-qb-processor.ts`, `lib/expense-qb-poster.ts` | `quickbooks.posting` in `lib/expense/configure.ts`; `app/api/cron/qbo-posting` | No single account for a line gives `qb_on_hold`. A failed post retries on the drain, then waits on finance as `NEEDS_FINANCE`. An expense whose own data can't make an entry (no receipt date, no lines, a line with no resolved account) waits on finance as `NEEDS_FINANCE` at once, with no retries. So does an expense tried before when the app can't tell whether QuickBooks already holds its entry. |
| Gift posting | bulk-donation, `lib/in-kind-poster.ts` | `inKindQbPosting()` in `lib/bulkDonation/configure.ts`; `app/api/cron/qbo-posting` | By the failure's kind: an outage, a lost connection or a settings gap is retried next run uncharged; a QuickBooks refusal goes to finance after one try; a bug retries up to `MAX_POST_ATTEMPTS`. A lost connection stops the run at once. Anything the drain can't settle goes to finance. A run that stops alerts finance with its cause. |

Three things commonly mislead a reader. A set `pushedAt` means workflow-mapping accepted the
receipt, and the money may still have failed there as `apply_failed`. Expense state `qb_complete`
means the entry is queued in the outbox; `qbMatchState` says whether QuickBooks has it, and posting
starts both on the request that finishes sign-off and from the daily drain. An imported receipt
already in QuickBooks travels the same path with `backfill` set, and expense ends it at
`qb_skipped` without posting.

Boot order and the binding itself are in `checkin-app/src/instrumentation.ts`, which only binds and
touches no database. Reads also run backwards along this path: `lib/receipt/configure.ts` imports
expense, workflow-mapping and bulk-donation to show the uploader what became of the purchase
(`purchaseOutcomes`), the reimbursement's status, and its confirmations. The rules these steps
enforce are in [expenses.md](../rules/expenses.md) and [revenue.md](../rules/revenue.md); the
injection seam is described in [COMPONENT_ARCHITECTURE.md](COMPONENT_ARCHITECTURE.md).

## Where to look when

- **A receipt hasn't reached finance.** Its state in `receipt.machine.ts`, and `validationNotes` on the receipt.
- **A finalized receipt isn't in workflow-mapping.** The receipt's audit log: `push_refused` when the receipt's payload check or workflow-mapping rejects it (catch-up stops retrying), `push_failed` for any other failure (catch-up retries), or `push_deferred` for a pending donor.
- **Workflow-mapping shows `apply_failed`.** `validationNotes` names the failed leg (Expense, Donation or Inventory).
- **A signed expense isn't in QuickBooks.** The expense's `state` and `qbMatchState`; `lib/quickbooks/health.ts` lists what posting lacks.
- **A gift isn't booking.** `waitingOn` in `inKindAcceptService.ts`.
- **A new port is needed between two libraries.** Declare it in the caller's `contract.ts`, then bind it in that caller's `configure.ts`.
