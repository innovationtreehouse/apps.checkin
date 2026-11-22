# Receipt package

`packages/receipt` (`@checkin/receipt`) takes a receipt in by upload, mail or
import, reads it with OCR when nobody typed the details, holds it for a person
when something looks wrong, and hands each finalized receipt to the rest of the
purchasing pipeline. It runs in the checkin process against its own database,
`RECEIPT_DATABASE_URL`. Files are stored in that database today; the move to a
private S3 bucket is partly built, and [File storage](#file-storage) says exactly
how far it has got.

This file describes the shape of the code.

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
| `alerts` | checkin's alert address | logged only |
| `fileStore` | see [File storage](#file-storage) | every file read and write throws |

## Intake paths

Upload and mail call `insertReceipt` in `src/lib/insert.ts`, and import calls
`insertReceiptsTogether`. Both write each row through `insertInto`, so a change to
how a row is written reaches all three paths, and a change to `insertReceipt` alone,
such as its limit pre-check, does not reach import.

- **Upload** (`POST /api/receipts/upload`). With details, the receipt starts at
  `uploaded` and the pipeline runs. With a file alone, it starts at `ocr_queued`,
  the request answers at once, and the reading runs after the answer. See
  [OCR](#ocr).
- **Mail.** Each file a message yields enters at `ocr_queued` as an auto upload by
  its verified sender, or waits in the mail queue. See [Mail](#mail).
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

Taking a receipt in and reading it are separate steps. A receipt nobody typed
details for is saved at `ocr_queued`, with `ocrQueuedAt`, and no request waits for
its reading.

**Readers.** Four things read a queued receipt, all through `readQueued` in
`src/services/receiptService.ts`:

| Reader | When | Cap |
|---|---|---|
| The upload's background read (`readInBackground`) | started as the upload answers, in the process that took it | that one receipt |
| "Read it again" | moves `ocr_failed` back to `ocr_queued`, answers, then reads in the background the same way | that one receipt |
| Finance assigning a held mail item, or releasing a deferred one (`src/services/mailQueueService.ts`) | reads the new receipt in the background the same way, then checks a mailed body for a copy | that one receipt |
| The drain (`drainOcrQueue` in `src/services/ocrDrain.ts`) | after the daily mail run and after finance's catch-up, under the mail lease | 20 readings, one at a time, oldest `ocrQueuedAt` first, within 10 minutes |

The background read is not awaited and holds no lease. A process that dies before
it claims the receipt leaves it at `ocr_queued` for the next daily drain; one that
dies after leaves it in `auto_upload` for the interrupted-OCR sweep. A replayed
email's receipts get no background read: they wait at `ocr_queued` for the next
daily drain.

**Claim.** A reader claims a receipt with a compare-and-set from `ocr_queued` to
`auto_upload` that stamps `ocrStartedAt`, and only the claimer reads it, so the
background read and the drain never read one receipt twice. The result is written
only while the receipt is still `auto_upload`.

**Allowance.** The claim charges the uploader's daily reading allowance, for uploads
and mail alike, and saving an upload charges nothing. A receipt over the allowance
lands in `ocr_failed` with a note to type the details or read it again tomorrow. With
automatic reading switched off, a new receipt lands in `ocr_failed` with the
switched-off note as it is saved, and a claimed one the same way; "Read it again"
answers 503 with that note.

**The page.** While a receipt is `ocr_queued` or `auto_upload`, its page shows
"Saved. Waiting to be read." or "Saved. Reading it now." and reloads it every 3
seconds for 3 minutes (`src/components/ReadingNotice.tsx`). Then it stops and says
"Still reading. This page updates when you reload it." The upload form never waits
on a reading.

**The call.** `createAnthropicOcr` in `src/lib/ocr.ts` calls the Anthropic API from
the app process: no Lambda.

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
pipeline sends it to `submitter_review` to be filled in.

From `ocr_failed` a person can type the details and resubmit, retry the reading,
discard the receipt or reject it. A good reading replaces whatever was typed, so the
page asks first, and `editsSinceReading` in `src/lib/submitterCorrections.ts` counts
only the field edits after the latest `ocr_complete` audit row as corrections. A receipt whose
reading died mid-call stays in `auto_upload` until the daily sweep moves it to
`ocr_failed`, once its reading started more than ten minutes ago. Nothing sweeps
`ocr_queued`: the drain reads it.

**Secret and selection.** The only secret OCR uses is `ANTHROPIC_API_KEY`, read from
the environment in `configure.ts`. The adapter follows `CHECKIN_ENV`,
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
Reading comes before the chain:

```
ocr_queued ──OCR_STARTED──▶ auto_upload ──OCR_SUCCEEDED──▶ uploaded ─▶ (the chain above)
    │                            └────────OCR_FAILED─────▶ ocr_failed   (a failed reading, reading switched off, allowance used up, file missing)
    ├──OCR_FAILED──▶ ocr_failed      (reading switched off when the receipt is saved)
    ├──DISCARD──▶ discarded
    └──REJECT───▶ rejected
ocr_failed ──OCR_RETRY──▶ ocr_queued
```

`ocr_queued` is labelled "Waiting to be read" and `auto_upload` is a reading in
progress. The submitter may discard a receipt in either, and finance may reject it. `flow_error` catches a
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

A mail run captures first and reads later. It runs as a step of the daily
`reconcile-shopify` request, or as finance's catch-up, and in this order:

1. Retry deferred items, oldest first (see the table below).
2. **List** the last 30 days, with no stored cursor. The query is
   `newer_than:30d -in:sent -in:drafts`, and Gmail's default search leaves out
   Spam and Trash.
3. **Capture** each listed message not yet captured and not finished, oldest first:
   fetch it with Gmail's `format=raw`, the whole RFC 822 message with Gmail's own
   `Authentication-Results` on top, write it to the file store, then insert its
   `ReceiptMailMessage` row. A message the `ReceiptMailItem` ledger shows finished is
   not fetched: it has a ledger row, none of them deferred, and no
   `ReceiptMailAtRisk` row.
4. **Process** each captured message with no `processedAt` and still inside its
   retention, oldest received first, from its stored copy.
5. Send the ageing alert, the acknowledgements owed and the held-ceiling alert.

Processing reads no receipt. `parseRawMail` in `src/lib/rawMail.ts` parses the raw
copy with postal-mime into the `MailMessage` shape the sender check and part
selection read, and a submitter's file becomes a receipt at `ocr_queued`. The drain
reads it after the run, and then discards a mailed body whose reading repeats a
receipt from its own message. A message processed without error gets `processedAt`.
One whose files were put off by a cap keeps it unset, and a failed one keeps its
kind and a short reason in `processError`; the next run processes either again,
from the stored copy. The ledger's unique `(gmailMessageId, attachmentHash)` makes
that free: it creates only what is missing. A message listed and not captured stays
in `ReceiptMailAtRisk`, so mail a run did not reach is fetched again, and runs can
stop for up to 30 days without losing mail. Once captured, a message no longer
depends on Gmail's 30-day window.

**Replay.** `processCapturedMessage(id)` runs step 4 for one captured message from
its stored copy. It is the same code the run uses, so a replay creates only what is
missing. Each replay writes a `mail_replayed` audit row naming who asked, before it
runs, and has 30 seconds in all. Its receipts are not read in the
background: they wait at `ocr_queued` for the next daily drain. Replay is finance's
work:

- `POST /api/receipts/mail-messages/[id]/replay` admits finance only, and no
  sysadmin. The answer is the outcome alone, never the email, its key or its headers.
- Retry on a stuck "mail message" item on the Problems list is the Board's only, and
  no sysadmin's (`checkin-app/src/lib/problemsRetryRoles.ts`).

Neither shows or downloads the email.

**Files in a message**, in reading order: each attachment of an accepted type, each
inline part of an accepted non-text type at 5 KB or more, then the body stored as
text. The body is measured as its visible text with trailer lines (`-- `, "Sent from
my …") deleted, never cut below them. Under 100 bytes it is skipped. Otherwise it is
read when it holds an amount (`$` before a digit, or a number with two decimals). A
long body with no amount is skipped beside any other file, accepted or refused; alone,
it gets a "no amount" notice for a resolved sender and is held for anyone else. A
message attached whole is never opened, only counted. Finance's ignore list, which finance adds to from
a discarded or rejected receipt, skips a file by exact hash, and upload never consults that list.

**Sender.** The address counts only when the message has one `From` with one
address, and the topmost `Authentication-Results`, written by `mx.google.com`,
shows a DMARC pass for that domain and a DKIM pass signed by exactly that domain.
`submitterByEmail` then has to resolve it to one person allowed to submit.

**Where a file goes.**

| Case | Result |
|---|---|
| Resolved sender, within limits | a receipt, at `ocr_queued`, with its ledger row in the same insert |
| Resolved sender, over their daily limit | `deferred`: stored, retried first on later runs, and finance may release it early |
| Anyone else | `held`, with a reason, until finance assigns or discards it |
| Anyone else, file refused | `held` with no file, naming the file and why, until finance discards it |

**Per-run budgets.** The volume is about 500 receipts a year, so one lease and one
daily run cover mail.

| Budget | Daily run | Catch-up |
|---|---|---|
| New receipts | 10 | 50 |
| Capture and processing time | 30 s, inside the scheduler's 60-second wait for the whole request | 10 minutes, after its request has answered |
| Raw mail captured | 100 MB | 100 MB |
| End-of-run calls (dating unread mail, alerts, acknowledgements) | 15 s after the capture budget | the same |
| Files charged to held mail | 50 files or 50 MB | the same |
| Held and deferred items stored in total, across runs | 500; past it nothing more is stored and finance is alerted | the same |

**Lease.** One mail lease per org covers a run from the start of capture to the end
of its drain, so the cron and a catch-up never overlap. Its length is the capture
budget, the drain's 10 minutes and 10 minutes of slack: 20½ minutes for the daily
run and 30 for a catch-up, and a crashed run blocks the next until it expires. Each
outside call races a deadline taken from it: capture's calls end with the capture
budget, and the drain's 10 minutes after the drain starts, both at least 3 minutes
before the lease ends. The daily request answers once capture and processing are
done, with their counts. The drain runs on after the answer and leaves its counts in
the lease's last-run summary, which the mail page shows, `crashed` for a drain that
crashed. With no mailbox bound, the daily step still runs the drain under the lease.

Mail a run leaves uncaptured is stored in `ReceiptMailAtRisk`, and finance gets one
alert once such a message would leave the window before the next run. A failed
listing sends no alert of its own: it counts as a failure in the cron result, so
the Problems list shows the job's latest run as failed and the daily problems email
lists it.

## Daily steps

There are no schedules of the library's own and nothing runs at boot. Six steps
run inside the host's existing daily `/api/cron/reconcile-shopify`, in this order,
each in its own `try/catch` and each returning counts only. None retries a failed step:

| Step | Moves | Cap per run |
|---|---|---|
| `sweepInterruptedOcr` | `auto_upload` older than ten minutes to `ocr_failed` | 50 |
| `sweepStuckUploaded` | `uploaded` idle for over an hour to `flow_error` | 50 |
| `takeInMailbox` | captures and processes the mailbox, and answers once that is done; the reading drain (`drainOcrQueue`) then reads `ocr_queued` receipts under the mail lease after the request answers, with or without a mailbox bound | see [Mail](#mail) and [OCR](#ocr) |
| `sweepOutcomeNotices` | sends the outcome emails still owed to a receipt's uploader and the person reimbursed; a notice is given up after three failed sends | 50 |
| `discardUnclaimedHeldMail` | a `held` mail item 90 days after it was held to `discarded`, audited as a finance discard is, with no actor; deletes its object | 50 |
| `sweepExpiredFiles` | deletes a receipt's object once its retention has ended and clears `file_key`; clears a discarded mail item's `file_key` 30 days after the discard, once its restore window has closed. Each is audited | 50 of each |

## Stuck receipts

After input, a receipt that fails a step is stuck in it: `flow_error`, or finalized with
`pushedAt` null. `firstFailedAt` keeps when the step first failed, and `lastError` the latest
failure's error; a step that succeeds clears both. A finalized receipt with `pushedAt` null
counts as stuck by its state alone once `PUSH_GRACE_MS` (ten minutes) has passed since its
finalize, so a push that crashed or could not record its failure is still found. A failure that
cannot be recorded is logged with the receipt id. `stuckItems()` lists stuck receipts for the
Problems list with no error text, timed by `firstFailedAt`, or failing that by the finalize. `retryStuckItem({ id, step })`
runs the step once ("flow" or "push to mapping"), and nothing retries by itself. It answers 404
for a receipt not stuck in that step and 409 when the receipt is still stuck afterwards. Finance sees
`lastError` on the receipt's own page.

`stuckItems()` also lists each captured email still unprocessed more than 25 hours after
capture (`WAITING_NOTICE_MS`), so the next daily run failed it too, as step "mail message",
timed from capture and linking to the mail page. Its Retry replays the email, is the Board's
only (see [Mail](#mail)), and answers 409 when the email is still not processed afterwards.
A captured email whose stored copy expires before it is processed drops off the list at
expiry. The decided design keeps it listed instead; see "Not built" under [File storage](#file-storage).

A failed reading leaves nothing stuck: the receipt waits in `ocr_failed` for its submitter. So
`problemNotices()` counts the `ocr_failed:<kind>` audit rows of the last day, and at
`READING_FAILURES_NOTICE_AT` (three) or more the Problems list carries one line,
"Receipt reading failed N times in the last day". A receipt waiting at `ocr_queued` is not
stuck either, and once any has waited more than 25 hours, so a daily drain has passed it by,
the Problems list carries one line, "N receipts waiting to be read, the oldest for D days".
A drain that crashed shows the same way the next day. Both lines reach the daily problems
email.

## Crossings

**S1, the push to workflow-mapping.** `pushReceipt` in `src/lib/receipt-flow.ts`
sends a `CompletedReceipt` from `@checkin/receipt-types` to `ingestReceipt`.

- The callee rejects any `orgId` other than the host's, and dedupes on `receiptId`:
  a replay answers `created: false`, even when the body differs, and counts as
  delivered. `submittedAt` is stamped fresh on each attempt, so bodies do differ.
- `submitterId` is the uploader's `Person.id`. `backfill` is true when the receipt
  has a QuickBooks link, which tells downstream not to post it again. `financeReview`
  is present only for an approved review.
- A push never throws to its caller. A failure leaves `pushedAt` null, a `push_failed`
  audit row with its kind in `valueBefore`, and the receipt stuck until a person sends
  it again (`push-to-inventory`, or Retry on the Problems list).
- A receipt whose `donorSync` is still `pending` is held back with a `push_deferred`
  audit row, so donations has the final in-kind state before the money side arrives.

**X13, in-kind donor to donations.** `src/lib/donor-sync.ts` sends either
`recordInKindDonor` or `withdrawInKind`, chosen from the receipt's current state.
Both are idempotent on `receiptId` and carry `donorSyncSeq`, so donations ignores a
call older than one it has seen. Donor names leave the library only here, never on
S1. `donorSync` is `none` for a receipt that was never in-kind, so a plain purchase
never sends a withdrawal. A failed send is a `donor_sync_failed` row with its kind in
`valueBefore`, and marks the receipt stuck. Its push waits on the donor, so sending the
receipt again sends the donor first.

**X12, reimbursement status.** `reimbursementStatus` asks expense, which reads
QuickBooks. The library stores no payment fact. A receipt missing from the answer
is not yet paid, and a failed read shows as "status unavailable".

## File storage

Every receipt and held mail item keeps its file in the store, under the row's
`file_key`. The `file_blob` column still exists, unread and unwritten, until its
drop. The buckets are set up outside this repo.

**Built.**

- `ReceiptFileStore` in `contract.ts` has `put`, `get` and `delete`, and the library
  takes no AWS dependency. `checkin-app/src/lib/receipt/fileStore.ts` binds S3 on
  every deployed instance and a temp directory under `CHECKIN_ENV=local`. The S3 put
  is write-once (`If-None-Match: *`) and carries a SHA-256 checksum. The temp-directory
  store also refuses a second write, and refuses bytes that miss their SHA-256.
- `file_key` and `file_size` exist on `receipts` and `receipt_mail_items`, and
  `receipts.file_blob` is nullable.
- Every new file goes to the store. The object goes first and the row second, and
  a failed insert deletes the object. Keys are `receipts/<receiptId>` and
  `mail-items/<uuid>`, and say nothing about the file.
- `readStoredFile` reads by `file_key` only. A row with no key logs and reads as
  missing: the file route answers 404 and OCR lands in `ocr_failed`.
- Assigning or discarding a stored mail item deletes its object after the commit.
  A discarded item keeps its `fileKey`, to name the object for an admin restore; an
  assigned one clears it.
- `backfillFiles` and `verifyFiles` in `src/services/fileBackfill.ts`, run by
  `checkin-app/scripts/receipt-file-backfill.ts`, copy existing rows' bytes to the
  store and check the copy. The copy sets `file_key` and `file_size` and never
  touches `file_blob`. How and when to run it is in
  `docs/ops/receipt-files-backfill.md`.
- Retention (`src/services/retention.ts`): an approved receipt's file is kept until
  7 years after its fiscal year's Form 990 deadline (November 15; the fiscal year
  ends June 30), dated by the receipt's date, else its approval; a rejected or
  discarded receipt's for 1 year after that decision; an undecided receipt's for
  good. The receipt row stays, and its file route answers 404.
- Daily byte limits sum `file_size`. The config-health page reports a deployed
  instance with no `RECEIPT_FILES_S3_BUCKET`, and such an instance refuses files
  with a 503 rather than falling back to the database.

**Captured mail.** Each captured email's raw copy is one object under
`mail-raw/<uuid>`, a key that says nothing about the message, written once with its
SHA-256 before its `ReceiptMailMessage` row (`orgId`, `gmailMessageId` unique per org,
`receivedAt`, `capturedAt`, `rawKey`, `rawSha256`, `rawSize`, `processedAt`,
`processError`). `rawKey` and `processError` are `pii`, the rest `internal`. The row
stays after the copy expires, so a message is never captured twice.

- **Retention**, by design: 90 days after capture in prod and 30 in dev and staging.
  The bucket's lifecycle rule expires the copies: a rule on `mail-raw/` in prod, and
  the rule that expires the whole bucket at 30 days in dev and staging. Both are set
  up outside this repo. The app holds the matching number, `rawMailRetentionDays`,
  bound in `configure.ts` from `CHECKIN_ENV`.
- **No delete.** The app never deletes raw mail, and the grant set up for it outside
  this repo gives put and get on `mail-raw/*`, never delete. A copy whose row failed to insert, or that lost a race
  to capture the same message, expires with the rest.
- Past retention, decided by `capturedAt` with no store call, the run skips the
  message and a replay answers "This email's stored copy expired N days after
  capture." Inside it, a missing copy is an error, recorded in `processError`.
- A raw copy is the whole email: other recipients, signatures, quoted threads, and
  mail that is no receipt. No route serves the raw copy, and no response or log carries its
  bytes, key or headers; errors record their kind and a short reason only. Files
  taken from it are stored as receipts or mail items with their own keys and
  lifetimes, and the copy expiring changes none of them.

**Not built.**

- Keeping expired captured mail on the stuck list, the decided design: a captured
  email whose stored copy expires before it is processed stays on the Problems list
  as a stuck "mail message", marked "expired, can't be replayed", with Dismiss only,
  until a person dismisses it, and is never dropped silently.
- Dropping the `file_blob` column, after re-pointing both file routes' registry
  entries from `fileBlob` to `fileKey`.

**Serving a file.** `GET /api/receipts/[id]/file` and
`GET /api/receipts/mail-items/[id]/file` are the only way a file's bytes leave, and
no presigned URL is issued. Both are `defineFileRoute` entries served by
`fileHandler`, and both registry entries still name `fileBlob` as the served field,
whichever store the bytes came from: the route loads them and passes them in under
that name.

| Who does it | What |
|---|---|
| `fileHandler` | authentication, admission, the per-row tier check (404 when it fails), the finance-view record of a marked file served to anyone but its owner, and the delivery headers |
| The library | the magic-byte check at intake, a `file_viewed` or `mail_file_viewed` audit row on each read, and loading the whole file into memory; nothing streams |

Images go `inline` under `Content-Security-Policy: sandbox`, PDFs `inline` without
it because Chrome's viewer refuses a sandboxed document, and text only as an
attachment. All of them carry `nosniff`. The receipt page shows text in a React text
node, so HTML source from a mailed body appears as visible tags.

`fileBlob` and `fileKey` are `pii` tier; `fileSize` and `fileHash` are `internal`.
List and mail-queue selects omit `fileBlob` and
`fileKey`. A missing object answers 404 on the file route and fails OCR into
`ocr_failed`.
