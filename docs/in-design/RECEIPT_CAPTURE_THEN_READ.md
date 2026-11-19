# Receipts: capture first, read later

## Problem

Reading a receipt automatically takes a call to an outside reading service, which
can take from a few seconds to two minutes. Today both ways a receipt arrives wait
for that call.

- **An upload** keeps the uploader's page waiting until the reading finishes. A slow
  reading looks like a frozen page, and a reading that never answers leaves the
  person unsure whether their receipt was saved.
- **The mailbox run** fetches each emailed receipt and reads it in the same scheduled
  request, ten per run. The scheduler that starts the run gives up after 60
  seconds, while one reading alone can take longer. A run that falls behind leaves
  mail in Gmail, and mail older than 30 days drops out of what the run looks at. If
  our handling of a message ever goes wrong, the only copy to try again from is
  Gmail's.

## Objective

Taking a receipt in and reading it are two separate steps.

- Capture is fast. Every new email is copied whole into our own storage, and every
  upload is saved, with no reading in the way. A captured email can be processed
  again from our copy, by a person or a test, without asking Gmail.
- Reading runs on its own: a drain with its own lock and cap reads waiting receipts
  oldest first. A failed reading lands where it does today, in "couldn't read" with
  "Read it again", and nothing retries by itself.
- The uploader is told at once that the receipt is saved and being read, and the
  page shows the reading when it lands.

## Executive summary

| Who | What changes | What stays |
|---|---|---|
| Uploader | The upload answers at once with "Saved. Reading it now"; the page fills in when the reading lands, usually within a minute. "Read it again" answers at once the same way. | Failures, their notes, typing the details by hand, the daily reading allowance. |
| Emailing a receipt | The daily run captures the mail and makes the receipt, then reads it minutes later, after the run's request has answered. The acknowledgement goes out as today. | Sender checks, holds, daily limits, refusal notices. |
| Finance | A receipt waiting to be read has its own state. The Problems list gets one line when reading falls behind, and one stuck item per captured email that could not be processed, with Retry. | Held mail, deferred mail, the mail page's catch-up button. |
| Sysadmins | A captured email can be processed again from our copy. | No new way to download mail. |

Cost: one table, one state and a MIME parser; raw email in the bucket for 90 days
(CR-2). The lease, the daily schedule and the infra stay as they are. Reading calls and their price are unchanged.

This builds on the merged per-call deadlines (#3613): every outside call in the
capture run and the drain still races a deadline taken from its lease. It replaces
the mail run's reading step, so the mail run's OCR deadline goes away and the drain
inherits it.

## Design

### States

One new state, `ocr_queued`: saved, waiting to be read. `auto_upload` keeps its
meaning, a reading is in progress, and `ocrStartedAt` keeps dating it.

```
ocr_queued ──OCR_STARTED──▶ auto_upload ──OCR_SUCCEEDED──▶ uploaded ─▶ (pipeline, unchanged)
    │                            └────────OCR_FAILED─────▶ ocr_failed
    ├──OCR_FAILED──▶ ocr_failed      (reading switched off, allowance used up, file missing)
    ├──DISCARD──▶ discarded
    └──REJECT───▶ rejected
ocr_failed ──OCR_RETRY──▶ ocr_queued   (was: ──▶ auto_upload)
```

- A new auto upload or mailed receipt is inserted at `ocr_queued`, with a new column
  `ocrQueuedAt`. "Read it again" moves `ocr_failed` back to `ocr_queued`.
- A reader claims a receipt with a compare-and-set `ocr_queued → auto_upload` that
  stamps `ocrStartedAt`. Only the claimer reads it, so the upload's background read
  and the drain can never read one receipt twice.
- The result applies only while the receipt is still `auto_upload`, as today.
- `sweepInterruptedOcr` is unchanged: `auto_upload` older than ten minutes goes to
  `ocr_failed`. Nothing sweeps `ocr_queued`; the drain reads it.
- Label: "Waiting to be read". The submitter may discard it, and finance may reject
  it, as from `auto_upload` today.

The reading allowance is charged when a reader claims the receipt, for uploads as
well as mail (CR-4). Over the allowance, the receipt goes to `ocr_failed` with
today's allowance note. Reading switched off sends a queued receipt to `ocr_failed`
with today's switched-off note, at insert when it is off then, or at claim.

### Upload

The upload request validates, saves the file and inserts at `ocr_queued`, then
answers with the receipt. After the response, `after()` from `next/server` reads
that one receipt: claim, then the same `readOne` the drain uses.

Why a background read and not the drain: the uploader is looking at the page. The
drain runs once a day, so a receipt left to it could wait a day. The background read starts within a second. The drain is the backstop: a
process that dies before the claim leaves the receipt `ocr_queued` for the next
daily drain, and one that dies after it leaves `auto_upload` for the sweep.

Concurrency is as today: each upload's reading runs in the process that took it,
with no queue in memory.

The receipt page polls while the state is `ocr_queued` or `auto_upload`: every 3
seconds for 3 minutes, then it stops and says "Still reading. This page updates when
you reload it." The upload form never waits on a reading.

### Mail capture

The mail run stays a step of the daily `reconcile-shopify` request, under its
existing lease. Its first part, capture, reads no receipt.

1. List the last 30 days' messages, as today.
2. Skip messages already captured, and messages the ledger shows finished from
   before this change (the existing finished-message check).
3. For each new message, oldest first: fetch it with Gmail's `format=raw`, the whole
   RFC 822 message as Gmail holds it, with Gmail's own `Authentication-Results`
   header on top. Write it to the bucket, then insert its `ReceiptMailMessage` row.
4. Process each captured, unprocessed message, oldest first, from the raw bytes.

Processing is today's per-message logic (`readMessage`, and the deferred retry
before it) with one change: a submitter's file becomes a receipt at `ocr_queued`
instead of being read. Held items, deferred items, refusals, the ledger rows and the
acknowledgements owed are all made as today.

The raw message is parsed into the `MailMessage` shape the processing already
reads, so the sender check, part selection and file hashes are unchanged code. A
golden test holds the parser to Gmail: for each fixture, parsing Gmail's raw form
gives the same files, types, sizes and hashes as Gmail's `format=full` and
attachment downloads.

A message processed without error gets `processedAt`. A failed one keeps its
latest error in `processError`, and the next run processes it again. That is today's
behaviour, where an unfinished message is read again each run, but from our copy.

Once captured, a message no longer depends on Gmail's 30-day window. The ageing alert
covers only messages listed and not yet captured.

### Replay

`processCapturedMessage(id)` runs step 4 for one captured message, from its stored
copy. It is the only processing code; capture calls it too.

It is safe to repeat. The ledger keeps one row per message and file, receipts are
inserted in the same transaction as their ledger row, and a reply is owed once per
message. A replay creates what is missing and nothing twice.

- **A person**: the stuck item on the Problems list, and "Process again" on the mail
  page's captured-message list, for finance and sysadmins (CR-3). Each replay is
  audited with who asked. Neither shows or downloads the email.
- **A test**: an `.eml` fixture is captured into the memory store and processed, with
  no Gmail.

### Storage, retention, privacy

| Item | Value |
|---|---|
| Bucket | the receipt bucket, which every deployed instance binds |
| Key | `mail-raw/<uuid>`, which says nothing about the message |
| Write | write-once with SHA-256, object first, then the row; a failed insert deletes the object |
| Row | `ReceiptMailMessage`: `orgId`, `gmailMessageId` (unique per org), `receivedAt`, `capturedAt`, `rawKey`, `rawSha256`, `rawSize`, `processedAt`, `processError`, `purgedAt` |
| Tiers | `rawKey` and `processError` are `pii`; the rest `internal` |
| Retention | 90 days after capture (CR-2), by a daily sweep that deletes the object, then clears `rawKey` and stamps `purgedAt`. The row stays, so the message is never captured again. |

A raw message is the whole email: other recipients, signatures, quoted threads, and
mail that is no receipt at all. So:

- No route serves it, and no response or log carries its bytes, key or headers.
  Errors record their kind and a short reason only, as the mail run's do now.
- Files taken from it are stored as today: as receipts, or as held and deferred
  items with their own objects and lifetimes. Purging the raw copy changes none of
  them.
- The bucket's policy already admits only the app's role and the admin role.
- Replay after purge answers "The stored copy has been deleted".

### Leases, caps and where each step runs

The volume is about 400 receipts a year, one or two a day, so one lease and one run
cover mail.

| Step | Runs | Lease | Cap per run |
|---|---|---|---|
| Capture and processing | inside the daily request, and in finance's catch-up | the existing mail lease | 30 s in the daily request (10 min for catch-up) and 100 MB of raw mail |
| Drain | after the daily request has answered, and after catch-up, still under the same lease | the same | 20 readings, one at a time, oldest `ocrQueuedAt` first, within 10 min |
| Upload read | after the upload answers | none: the claim is the lock | one receipt |

The lease runs from the start of capture to the end of the drain, so the cron and a
catch-up never overlap and a crashed run blocks the next only until it expires.

The scheduler waits 60 seconds for the whole `reconcile-shopify` request. Capture is
its only mail work inside the request: 30 seconds at most, with each outside call's
deadline inside that. Its counts go in the response, so the cron log records a failed
listing as today. The drain starts after the response and leaves its counts in the
lease's last-run summary.

Messages beyond the byte cap or the budget wait for the next day, or for finance's
catch-up button.

### What finance and the Problems list see

| Situation | Where it shows |
|---|---|
| Receipts waiting | state "Waiting to be read" in the queues and counts |
| Reading behind or stopped: a receipt has waited more than 25 hours, so a daily run has passed it by | one Problems line, "N receipts waiting to be read, the oldest for D days", which also reaches the daily problems email |
| Drain crashed | the same line the next day. The mail page shows the run's last summary as `crashed`. |
| Captured message not processed 25 hours after capture, so the next daily run failed it too | stuck item, step "mail message", timed from capture, Retry = replay |
| Listing or capture failing | the cron job's run fails, as the mail step does today |
| Readings failing | today's line, three or more failed readings in a day |

### Duplicates and idempotency

- **Capture**: one row per org and Gmail message. Two runs racing on one message: the
  loser's insert fails on the unique key and it deletes its own object.
- **Processing**: the ledger's unique (message, file hash) key, with the receipt and
  its ledger row in one transaction, as today. Replay relies on it.
- **Reading**: the claim is a compare-and-set, and the result writes only from
  `auto_upload`.
- **Receipt duplicates** (same file, or same retailer, date and total) are found by
  the pipeline after the reading, unchanged.
- **Acknowledgements**: one row per message, as today. They don't depend on the
  reading.

## Tests

No database, in `packages/receipt` unit tests:
- the machine's new transitions, and that `OCR_RETRY` now lands in `ocr_queued`;
- the raw parser against Gmail's `format=full` fixtures (the golden test above),
  including a forwarded message, an inline image under the floor, a body-only
  receipt, an RFC 2047 file name and an RFC 2231 one;
- deadlines for capture and the drain fall before their leases.

Integration (database, CI):
- capture stores the raw copy and its row, writes nothing more on a second run, and
  answers within its budget with a hung fetch;
- processing from raw makes the same ledger rows, receipts, holds and replies as
  today's fixtures;
- replay of a processed message changes nothing; replay after a crash between two
  files makes only the missing one; replay after purge answers its error;
- the drain reads oldest first, stops at its cap, and skips a receipt the upload read
  claimed;
- upload answers at `ocr_queued`; the background read lands `uploaded` or
  `ocr_failed`; a crash before the claim leaves it for the drain;
- the allowance charged at claim, the switched-off note, and the purge sweep;
- the Problems line and the stuck mail message with its Retry.

Flow: upload then poll until the reading lands. Browser e2e: the upload page shows
"Reading it now" and then the reading, and never a blocked form.

## Alternatives considered

- **No new state: `auto_upload` with no `ocrStartedAt` means waiting.** Fewer code
  changes, but finance couldn't tell a backlog from a reading in progress, and every
  query on `auto_upload` would need the extra condition.
- **Uploads wait for the drain.** One code path, but the uploader waits up to 15
  minutes (now a day).
- **Keep reading Gmail's parsed form and store the raw copy only for replay.** Normal
  processing and replay would read different inputs, so a replay could disagree with
  what happened.
- **A bucket lifecycle rule for retention.** That lives in the infra repo where no
  test reaches it, and it can't stamp the row.
- **Its own scheduled call every 15 minutes, with a separate drain lease.** Faster
  capture, but it needs an infra schedule, a new route and a second lease, which 400
  receipts a year don't need. The catch-up button covers a day that can't wait.
