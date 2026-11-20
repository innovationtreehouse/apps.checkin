# Receipts: capture first, read later — cutover

Everything here stops being true once the change has run. The design is
[`RECEIPT_CAPTURE_THEN_READ.md`](RECEIPT_CAPTURE_THEN_READ.md).

## Owner decisions

- **CR-1 — answered:** mail stays daily inside `reconcile-shopify`. No new route and
  no infra schedule. Caps and thresholds are sized for about 500 receipts a year.
- **CR-2 — answered:** by S3 lifecycle, per environment: 90 days after capture in
  prod, by a rule on `mail-raw/`; 30 days in dev and staging, by their existing
  whole-bucket rule. The app holds the matching number per environment and adapts to
  the infra. The app gets put and get, never delete.
- **CR-3 — answered:** finance and sysadmins, the same people as the mail catch-up
  button.
- **CR-4 — answered:** charge the allowance when a reading starts, uploads included.
  An upload over it is saved and lands in `ocr_failed` with the allowance note. The
  limits are unchanged, and upload-count and byte limits still refuse before saving.
- **CR-5 — answered:** yes. The bucket exists and is on in dev, staging and prod.

## Build order

1. Schema (additive: `ocrQueuedAt`, `ReceiptMailMessage`), machine, drain, upload
   background read, page polling.
2. Raw capture, parser, processing from raw, replay. In each environment it waits on
   the owner's lifecycle rule and grant for `mail-raw/`.
3. The registry entry for the replay route, in its own PR. Then the route and the
   Problems lines.

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
