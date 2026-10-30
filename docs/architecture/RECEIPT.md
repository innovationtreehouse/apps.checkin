# Receipt package

`packages/receipt` (`@checkin/receipt`) takes a receipt in by upload, mail or
import, reads it with OCR when nobody typed the details, holds it for a person
when something looks wrong, and hands each finalized receipt to the rest of the
purchasing pipeline. It runs in the checkin process against its own database,
`RECEIPT_DATABASE_URL`. Files are stored in that database today; the move to a
private S3 bucket is partly built, and [File storage](#file-storage) says exactly
how far it has got.

This file describes the shape of the code. The rules a change must not violate,
such as who may approve or discard a receipt, are in `docs/rules/expenses.md`.

---

## How the host wires it in

The library never imports checkin or a sibling library. `src/contract.ts` declares
one port per crossing, and `checkin-app/src/lib/receipt/configure.ts` binds them
once at server boot, touching no database and no network. A port left unbound
falls back to an inert adapter in `src/runtime.ts`. An inert outbound port throws,
so work waits for a retry and nothing pretends to have been delivered.

| Port | Bound in checkin to | Unbound behaviour |
|---|---|---|
| `auth` | the session's `Person`; `null` for a refused session or one naming no live person | required |
| `org` | the host's org | required |
| `receiptSink` | `ingestReceipt` in `@checkin/workflow-mapping` | throws; the receipt waits unpushed |
| `donorSink` | `recordInKindDonor`, `withdrawInKind` in `@checkin/bulk-donation` | throws; `donorSync` stays `pending` |
| `reimbursementStatus`, `submitterConfirmations` | `@checkin/expense` | every receipt reads not yet paid; nothing awaits confirmation |
| `purchaseOutcomes` | a join of receiving, expense and donations | nothing known downstream |
| `households`, `people`, `reimbursees` | checkin's `Person` and household data | no households; every mailed file is held; nobody to name as reimbursee |
| `ocr` | `fixtureOcr` under `CHECKIN_ENV=local`, else `createAnthropicOcr` | every reading fails with "OCR is not configured" |
| `mailbox` | a Gmail reader, on the conditions under [Mail](#mail) | mail intake reports `unbound` and does nothing |
| `replies` | checkin's outgoing mail | acknowledgements wait unsent |
| `alerts` | checkin's finance alert | logged only |
| `fileStore`, `storeNewFilesInBucket` | see [File storage](#file-storage) | any access to a stored object throws |

## Intake paths

All three paths go through `insertReceipt` in `src/lib/insert.ts`.

- **Upload** (`POST /api/receipts/upload`). With details, the receipt starts at
  `uploaded` and the pipeline runs. With a file alone, it starts at `auto_upload`
  and OCR runs in the same request.
- **Mail.** Each file a message yields enters as an auto upload by its verified
  sender, or waits in the mail queue. See [Mail](#mail).
- **Import** (`POST /api/receipts/import`, finance only). At most 50 receipts per
  call, in one transaction: a bad row refuses the whole batch. A re-run skips rows
  already loaded, by the unique `(orgId, importSourceId)`. A receipt with a
  QuickBooks link skips the submitter step and the age check, and goes downstream
  marked `backfill`.

**File checks** (`src/lib/file-type.ts`). A file may be at most 10 MB (11 MB for
the whole upload request), and a receipt at most 200 lines. The file's type is one
of JPEG, PNG, GIF, WebP, PDF or `text/plain`, and its content must match: magic
bytes for the first five, valid UTF-8 with no NUL byte for text. The stored bytes
are the bytes received.

**Daily limits** (`src/lib/limits.ts`) run over a rolling 24 hours.

| Limit | Value |
|---|---|
| Uploads per person, by hand or assigned by finance | 30 |
| Mailed receipts per person | 5 |
| Mailed receipts for a program lead or Board member | 25 |
| Stored bytes per person | 100 MB |
| Stored bytes for the org | 500 MB |
| OCR calls per person, counted from audit rows | 50 |

## Duplicates

A duplicate is stored and flagged, because `(orgId, fileHash)` on `Receipt` is a
plain index and never refuses an insert. `insertInto` takes a transaction-scoped
advisory lock on the org and file hash, so a second concurrent upload of one file
always sees the first, and records the earliest receipt with that hash as its
suspect.

The pipeline then decides from `checkDuplicate`, which reads the receipt's group
in `src/lib/duplicateGroup.ts`. Two receipts match on the same file hash, or on the
same retailer with the same date and total, the same order number, or the same
receipt number; retailers and numbers compare after folding case and whitespace.
Groups are transitive. A pair a person marked as different purchases stops
matching, and so does a mailed body discarded as a copy of its own message's
attachment.

## OCR

`createAnthropicOcr` in `src/lib/ocr.ts` calls the Anthropic API from the app
process: no Lambda and no queue. A request waits for the reading.

| Setting | Value |
|---|---|
| Model | `claude-opus-5-5`, with `output_config.effort` `medium` |
| Output | structured outputs: `output_config.format` with `EXTRACT_SCHEMA` |
| Refusals | server-side fallback beta, `fallbacks: "default"`; a final `stop_reason: "refusal"` is a failure |
| Client | 120 s timeout, 2 SDK retries; the app adds no retry of its own |
| File | bytes in the request, base64 except text; the API never fetches a URL |
| Total | `receiptTotalText` wins over the number, because a model can drop the decimal from a JSON number and still copy the printed string |

Everything that comes back is treated as untrusted. `OcrDataSchema` bounds each
field, and it holds only the receipt's own details, so a reading cannot set the
reimbursee, the vendor or `needsReimbursement`.

`applyOcr` in `src/services/receiptService.ts` writes a good reading's details and
lines in one transaction with the move to `uploaded`. Any failure moves the receipt
to `ocr_failed` with the reason in `validationNotes` and writes nothing from the
reading. A reading with lines but no retailer, date or total counts as good; the
pipeline sends it to `submitter_review` to be filled in. The rule is in
`docs/rules/expenses.md`.

From `ocr_failed` a person can retry the reading, discard the receipt or reject it.
The state is not editable, so nobody types details into a receipt there; a person
who wants to type them discards it and uploads again with details. A receipt whose
request died mid-call stays in `auto_upload` until the daily sweep moves it to
`ocr_failed`, once it is more than ten minutes old.

**Secret and selection.** The only secret the library uses is `ANTHROPIC_API_KEY`,
read from the environment in `configure.ts`. The adapter follows `CHECKIN_ENV`,
never whether a key is set: `local` binds the fixture, and anything else binds the
real client, which fails every reading with "OCR is not configured" when the key
is missing. Manual entry keeps working either way. Whether a given environment has
the key is set in the infra repo and cannot be read from this one.

## State machine

`src/workflows/receipt.machine.ts` is the source of truth, with its guards in
`receipt.guards.ts`. `RUN_PIPELINE`, from `uploaded` or `flow_error`, takes the
first match:

1. retailer, date or total missing: `submitter_review`
2. a duplicate: `duplicate_flagged`
3. no lines, or lines that do not balance: `validation_failed`
4. mailed, read by OCR, or claiming reimbursement, and not yet reviewed: `submitter_review`
5. needing finance review and not approved: `financial_review`
6. otherwise: `receipt_finalized`

Each stop returns to `uploaded` when resolved, and the pipeline runs again.
`auto_upload` and `ocr_failed` come before the chain. `flow_error` catches a
pipeline that threw or never ran, and finance can restart it. `receipt_finalized`,
`discarded` and `rejected` are terminal.

## Mail

`readMailbox` in `src/services/mailIntake.ts` reads one Gmail mailbox with a
read-only token. The app never labels, moves or deletes mail.

**Binding.** `receiptMailbox()` in `configure.ts` binds the reader only on
`CHECKIN_ENV` `prod`, `dev` or `stg` with both `GMAIL_REFRESHER_FN` and
`RECEIPT_MAILBOX_ADDRESS` set. Off prod it also needs `RECEIPT_PROD_MAILBOX_ADDRESS`
set to a different mailbox. The access token comes from an Infra-owned refresher
Lambda, which alone holds the refresh token; an answer naming another mailbox is
refused.

**Reading.** The window is the last 3 days, with no stored cursor, and the
`ReceiptMailItem` ledger makes a re-read free through its unique
`(gmailMessageId, attachmentHash)`. The query is `newer_than:3d -in:sent -in:drafts`,
and Gmail's default search leaves out Spam and Trash.

**Files in a message**, in reading order: each attachment of an accepted type, each
inline part of an accepted non-text type at 5 KB or more, then the body stored as
text. A body with no amount written to two decimals is skipped. A message attached
whole is never opened, only counted. Finance's ignore list skips a file by exact
hash, and upload never consults that list.

**Sender.** The address counts only when the message has one `From` with one
address, and the topmost `Authentication-Results`, written by `mx.google.com`,
shows a DMARC pass for that domain and a DKIM pass signed by exactly that domain.
`submitterByEmail` then has to resolve it to one person allowed to submit.

**Where a file goes.**

| Case | Result |
|---|---|
| Resolved sender, within limits | a receipt, at `auto_upload`, with its ledger row in the same insert |
| Resolved sender, over their daily limit | `deferred`: stored, retried first on later runs, and finance may release it early |
| Anyone else | `held`, with a reason, until finance assigns or discards it |

**Per-run budgets.**

| Budget | Value |
|---|---|
| New receipts (OCR calls) | 10 |
| Files charged to held mail | 50 files or 50 MB |
| Held and deferred items stored in total, across runs | 500; past it nothing more is stored and finance is alerted |
| Starting new messages | stops after 2 minutes |

Mail a run leaves unread is stored in `ReceiptMailAtRisk`, and finance gets one
alert once such a message would leave the window before the next run. A failed
listing alerts finance on every run and counts as a failure in the cron result.

## Catch-up steps

There are no schedules of the library's own and nothing runs at boot. Five steps
run inside the host's existing daily `/api/cron/reconcile-shopify`, in this order,
each in its own `try/catch` and each returning counts only:

| Step | Moves | Cap per run |
|---|---|---|
| `sweepInterruptedOcr` | `auto_upload` older than ten minutes to `ocr_failed` | 50 |
| `sweepStuckUploaded` | `uploaded` idle for over an hour to `flow_error` | 50 |
| `repushUnpushed` | finalized and unpushed receipts, sent again | 50 |
| `resendDonorSync` | `donorSync = pending`, sent again | 50 |
| `readMailbox` | the mailbox, last because it is the only slow step | as above |

## Crossings

**S1, the push to workflow-mapping.** `pushReceipt` in `src/lib/receipt-flow.ts`
sends a `CompletedReceipt` from `@checkin/receipt-types` to `ingestReceipt`.

- The callee rejects any `orgId` other than the host's, and dedupes on `receiptId`:
  a replay answers `created: false`, even when the body differs, and counts as
  delivered. `submittedAt` is stamped fresh on each attempt, so bodies do differ.
- `submitterId` is the uploader's `Person.id`. `backfill` is true when the receipt
  has a QuickBooks link, which tells downstream not to post it again. `financeReview`
  is present only for an approved review.
- A push never throws to its caller. A failure leaves `pushedAt` null with a
  `push_failed` audit row, for the catch-up step or the manual `push-to-inventory`
  route. Catch-up skips a receipt after five of its own failures in a row, until a
  manual push of it or any delivery in the org.
- A receipt whose `donorSync` is still `pending` is held back with a `push_deferred`
  audit row, so donations has the final in-kind state before the money side arrives.

**X13, in-kind donor to donations.** `src/lib/donor-sync.ts` sends either
`recordInKindDonor` or `withdrawInKind`, chosen from the receipt's current state.
Both are idempotent on `receiptId` and carry `donorSyncSeq`, so donations ignores a
call older than one it has seen. Donor names leave the library only here, never on
S1. `donorSync` is `none` for a receipt that was never in-kind, so a plain purchase
never sends a withdrawal.

**X12, reimbursement status.** `reimbursementStatus` asks expense, which reads
QuickBooks. The library stores no payment fact. A receipt missing from the answer
is not yet paid, and a failed read shows as "status unavailable".

## File storage

The S3 move is partly built. The code to write to and read from a bucket has
shipped behind a flag that defaults to off, and the steps that would empty the
database column have not been built. Whether the buckets exist, and whether the
flag is on in a given environment, is set outside this repo.

**Built.**

- `ReceiptFileStore` in `contract.ts` has `put`, `get` and `delete`, and the library
  takes no AWS dependency. `checkin-app/src/lib/receipt/fileStore.ts` binds S3 on
  every deployed instance and a temp directory under `CHECKIN_ENV=local`. The S3 put
  is write-once (`If-None-Match: *`) and carries a SHA-256 checksum. The temp-directory
  store refuses a second write and does not check the hash.
- `file_key` and `file_size` exist on `receipts` and `receipt_mail_items`, and
  `receipts.file_blob` is nullable.
- `RECEIPT_FILES_S3=true` sends new files to the bucket. The object goes first and
  the row second, and a failed insert deletes the object. Keys are
  `receipts/<receiptId>` and `mail-items/<uuid>`, and say nothing about the file.
- With the flag off, new files go to `file_blob`, as they always have.
- `readStoredFile` reads from the store when a row has a key and from `file_blob`
  otherwise, so both kinds of row are served at once.
- Assigning or discarding a stored mail item deletes its object after the commit.
  A discarded item keeps its `fileKey`, to name the object for an admin restore; an
  assigned one clears it.
- Daily byte limits sum `file_size`, falling back to the column's length for older
  rows. The config-health page reports a flag that is on with no
  `RECEIPT_FILES_S3_BUCKET`, and with the flag on and no bucket a deployed instance
  refuses files with a 503 rather than falling back to the database.

**Not built.**

- A task that copies existing rows' bytes to the bucket and verifies them. Rows
  stored in `file_blob` stay there.
- Removing the `file_blob` reads and the flag, then dropping the column.
- Retention: nothing deletes a receipt file on a schedule.
- Automatic discard of held mail nobody acts on: a held item waits for finance.

**Serving a file.** `GET /api/receipts/[id]/file` and
`GET /api/receipts/mail-items/[id]/file` are the only way a file's bytes leave, and
no presigned URL is issued. Both are `defineFileRoute` entries served by
`fileHandler`, and both registry entries still name `fileBlob` as the served field,
whichever store the bytes came from: the route loads them and passes them in under
that name.

| Who does it | What |
|---|---|
| `fileHandler` | authentication, admission, the per-row tier check (404 when it fails), the finance-view record of `auditedRead`, and the delivery headers |
| The library | the magic-byte check at intake, a `file_viewed` or `mail_file_viewed` audit row on each read, and loading the whole file into memory; nothing streams |

Images go `inline` under `Content-Security-Policy: sandbox`, PDFs `inline` without
it because Chrome's viewer refuses a sandboxed document, and text only as an
attachment. All of them carry `nosniff`. The receipt page shows text in a React text
node, so HTML source from a mailed body appears as visible tags.

The file columns are `pii` tier. List and mail-queue selects omit `fileBlob` and
`fileKey`. A missing object answers 404 on the file route and fails OCR into
`ocr_failed`.
