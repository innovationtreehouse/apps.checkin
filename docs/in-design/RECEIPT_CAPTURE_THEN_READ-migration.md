# Receipts: capture first, read later — cutover

Everything here stops being true once the change has run. The design is
[`RECEIPT_CAPTURE_THEN_READ.md`](RECEIPT_CAPTURE_THEN_READ.md).

## Owner questions

- **CR-1** Run capture from its own scheduled call every 15 minutes (infra adds the
  schedule), or keep it daily inside `reconcile-shopify`?
- **CR-2** Keep raw mail for 90 days after capture, then delete it? Or longer, or
  for as long as receipt files?
- **CR-3** Who may press "Process again": finance and sysadmins, or sysadmins only?
- **CR-4** Charge the reading allowance when the reading starts, for uploads too? An
  upload over the allowance is then saved and lands in "couldn't read" with the
  allowance note, where today it is refused before saving.
- **CR-5** Is the receipt bucket live in prod before receipts go live? Capture needs
  it in every environment.

## Build order

1. Schema (additive: `ocrQueuedAt`, `ReceiptMailMessage`, `ReceiptReadLease`),
   machine, drain, upload background read, page polling.
2. Raw capture, parser, processing from raw, replay, purge sweep.
3. Registry entries for the `receipt-mail` cron route and the replay route, in their
   own PR. Then the routes and the Problems lines.
4. Infra adds the 15-minute schedule (CR-1). Until then the step stays in
   `reconcile-shopify`; PR 3 removes it from there only once the schedule runs.

## In-flight rows

- **`auto_upload` at deploy.** Old instances still read inline during the rolling
  deploy. Anything they leave is older than ten minutes by the next sweep, which moves
  it to `ocr_failed` as today.
- **`ocr_queued` seen by an old instance.** Old code has no label for it and no
  transition from it, so an action on it there answers the illegal-transition error.
  The drain window is minutes, and no old sweep touches the state.
- **Messages already finished.** The ledger's finished-message check skips them, so
  the first capture doesn't copy 30 days of old mail.
- **Messages unfinished at deploy** (at-risk, partly read, or with deferred items).
  They are captured on the first run and processed from raw. The ledger skips the
  files already taken.
- **Deferred and held items** keep their own files and states; nothing moves.
- **The mail lease** is reused as the capture lease. Its stored last-run summary
  keeps its shape.

## Landing

When the last build PR merges: fold the design into
`docs/architecture/RECEIPT.md` (OCR, state machine, daily steps, file storage) and
`docs/architecture/RECEIPT_PIPELINE.md` (the Upload and Mail rows), then delete both
files.
