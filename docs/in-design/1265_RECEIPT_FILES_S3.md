# Receipt files: moving from the receipt database to a private S3 bucket

**Status: PROPOSED, for owner ruling. No code until ruled.** Amends #1265 §3
("File storage").

Receipt files and held mail-item files move out of the receipt database, where
they sit as `bytea` on the Postgres server checkin shares, into one private S3
bucket per environment. The app is the only thing that reads or writes the
bucket: it puts a file when a receipt or held item is created, and it reads the
file back on the server, for the file route and for OCR. The browser never talks
to S3. Existing rows move by copy-then-switch; the `bytea` column and its data
stay until the owner rules otherwise.

**Why now.** #1265 §3 chose `bytea` on the assumption that only signed-in
submitters upload, under daily limits. Gmail intake (#2222) changed that: any
sender on the internet can make the app store up to 10 MB per attachment as a
held mail item, outside any submitter's upload limits (§2a). Those bytes land in
the database checkin runs on, so mail volume, up to the flooding caps, grows
checkin's database, its backups and its restore time. Manual uploads move too, so there is one
storage path and not two.

**Pattern followed.** `checkin-app/src/lib/membership/contract/agreementDocument.ts`
reads the membership-agreement PDF from a private bucket with the ECS task role:
region and credentials come from the environment, the bucket name from an env
var, and a missing bucket makes the feature report "unavailable" instead of
falling back. Receipts reuse that shape and add writes. The agreement code
never signs a URL; "signed" there means the Zoho e-signature, so there is no
existing presigned-URL pattern to follow.

---

## 1. Object keys

| File | Key | Written |
|---|---|---|
| Receipt file | `receipts/<receiptId>` | once, when the receipt is inserted |
| Held mail item | `mail-items/<uuid>` | once, when the item is held |

- `receiptId` is the receipt's UUID, which `insertReceipt` already generates
  before its transaction. A mail item's id is an autoincrement assigned at
  insert, so it gets a fresh UUID for its key instead.
- Keys carry no file name, sender, hash or org. A key shows up in access logs and
  CloudTrail, so it must say nothing about the file.
- No environment in the key: each environment has its own bucket (§5).
- Every put is **write-once** (`If-None-Match: *`): a key, once written, can't be
  written again with different bytes. That stops overwrites only; it doesn't stop
  deletes, which are governed by the role and lifecycle rules in §6. Every put also
  carries **`ChecksumSHA256`** set to the hash the row
  already stores (`Receipt.fileHash`, `ReceiptMailItem.attachmentHash`). S3
  refuses a body that does not match, so every stored object is verified at the
  moment it is written.

New columns on both `receipts` and `receipt_mail_items`:

- `file_key TEXT NULL`, tier **`pii`**. The key is opaque, but it is the handle
  to `pii` bytes, and when the file column is eventually dropped the file route's
  per-row tier check will key on it (§7). Tagging it `pii` now keeps that check at
  today's tier and keeps the key out of JSON responses.
- `file_size INT NULL`, tier `internal`. The daily byte limits sum
  `octet_length(file_blob)` today; with the bytes gone they sum this instead.

`file_key IS NULL` means "the bytes are still in `file_blob`". That one column is
the per-row switch the migration turns (§4).

## 2. Writes

The library gets one new port in `contract.ts`, a file store with `put`, `get`
and `delete`. The host binds it; `packages/receipt` takes no AWS dependency.

| `CHECKIN_ENV` | Binding |
|---|---|
| `dev`, `stg`, `prod` | S3, bucket from `RECEIPT_FILES_S3_BUCKET`. Unset bucket: uploads and intake fail with 503, as the agreement sign endpoint does; the config-health page shows the gap. |
| `local` (dev server, flow tests) | a directory under the OS temp dir |
| vitest | an in-memory fake |

The binding follows `CHECKIN_ENV`, never whether a bucket is set (*Principle:
fail closed*). A deployed instance with no bucket refuses files; it never writes
them back into the database.

**Order: object first, then row.** The put happens before the insert
transaction, and the row is written with `file_key` set. If the transaction then
fails (the in-transaction limit check loses a race, a database error, a
concurrent mail run hitting the unique key), the object is left behind with no
row. The app deletes it on the way out of the failed insert. A crash between the
put and the delete leaves an orphan, which is never served, because nothing
references it.
`ponytail:` crash orphans are not swept; ceiling is orphan volume, and a sweep
that lists keys with no row is the upgrade if anyone ever measures it. The cheap
pre-check of the daily limits runs before the put, so a refused upload stores
nothing in the common case.

**Mail items.** Holding an item puts `mail-items/<uuid>`. Assigning one (#2239)
runs the normal receipt insert, which puts `receipts/<newId>` from the same
bytes, and clears the item's `file_key` in the claim. Discarding clears it too.
After either commits, the app deletes the `mail-items/` object. Versioning keeps
the deleted object for the lifecycle window (§6), which is the recovery window
for a mistaken discard.

**Cleaning up spam.** Mail from a sender the app can't attribute never becomes a
receipt; it's held in `mail-items/` until finance acts, so spam stays in the one
prefix the app already deletes from. Three things clear it:

- Finance discards an item on the mail-queue page (#2239), which deletes its file.
- Held items nobody acts on are discarded by the daily mail step after a set age
  (Q-S3-2), with an audit row, exactly as a finance discard is. So a flood clears
  itself without anyone working the queue. This is app code, not an S3 lifecycle
  rule: a rule would delete the file and leave its row held in the queue.
- An account admin can delete objects directly in the AWS console or CLI (§6).

A "discard every held item from this sender" button is a small addition to the
mail-queue page if finance ever needs it; nothing here builds it.

## 3. Reads: the app reads and serves; no presigned URLs

The file route and OCR both call the file store's `get`, which reads the whole
object into memory and returns it as bytes. The file route hands those bytes to
`fileHandler` exactly as it hands over `file_blob` today, so the route, the
registry entry and `fileHandler` itself do not change.

A presigned URL would send the browser straight to S3, and four things this
design depends on would stop holding:

- **Headers.** `fileHandler` sets `nosniff`, `Content-Security-Policy: sandbox`
  on images, and the per-type disposition (text always downloads). A presigned
  GET can override content type and disposition, but not CSP.
- **One audit row per view.** A presigned URL is a bearer token: anyone holding
  it can fetch the file until it expires, from browser history, a forwarded link
  or a proxy log, and none of those fetches is audited.
- **The per-row scope check** runs at the moment of the request. A URL minted
  for one caller outlives that check.
- **No public path to the bucket at all.** With server reads only, the bucket
  policy can refuse everything except the app's task role (§6). Presigning needs
  the bucket reachable from the internet for whoever holds a URL.

The cost is that file bytes pass through the app process: at most 10 MB per
read, at hundreds of receipts a year.
`ponytail:` reads buffer the whole object instead of streaming it, because
`fileHandler` takes a `Uint8Array` and sets `Content-Length`. Streaming would be
a boundary-file change with no gain at 10 MB; revisit only if the file cap rises
well past that.

A missing object (staging's copied rows, §5, or a bug) answers 404 on the file
route, which is what the route already answers for a file the caller may not
see, and fails OCR into `ocr_failed`.

## 4. Moving existing rows: copy, verify, then switch

Additive throughout. No step deletes or overwrites a byte in the database.

1. **Expand** (library PR): add `file_key` and `file_size`, and drop `NOT NULL`
   on `receipts.file_blob`, in one migration wrapped in `BEGIN;`/`COMMIT;`.
   Ship the read path that prefers `file_key` and falls back to `file_blob`, and
   the write path behind the flag `RECEIPT_FILES_S3` (default off). With the flag
   off, behavior is unchanged and old code is safe against the new schema: every
   row still has its bytes.
2. **Flip the flag** per environment once that release is fully rolled out
   there. Only then do new rows have a null `file_blob`, so no old task, still
   reading `file_blob` alone, ever meets one.
3. **Backfill** (one-off task): for each row with `file_key IS NULL` and bytes
   present, put the object (write-once, checksummed), then
   `UPDATE ... SET file_key, file_size WHERE id = $1 AND file_key IS NULL`.
   Batches of 50, re-runnable: a put that finds the key already there checks the
   stored checksum and moves on. It runs as a one-off ECS task with the app's task
   definition, because the database is VPC-only, with the Aurora resume retry
   (DEPLOY_MIGRATION_ORDER_OF_OPERATIONS rule 8).
4. **Verify**: the same script with `--verify` reads every object whose row still
   has bytes and compares its SHA-256 with the hash of `file_blob` and with the
   stored hash. Zero mismatches, and zero rows with bytes but no key, is the gate
   for step 5, per environment.
5. **Remove the `bytea` reads and the flag.** The read path uses `file_key` only;
   a row without one logs and answers 404. The column and its bytes stay.

Dropping `file_blob`, and nulling its bytes first, is a later contract step for
the owner to schedule (rule 3: a separate release after step 5 has rolled out).
It also needs a boundary PR first, re-pointing the two file routes' registry
entries from `fileBlob` to `fileKey`; §1's `pii` tag is what keeps that a
re-point and not a re-tier. Nothing in this plan schedules it.

## 5. Environments

| Environment | Bucket | Notes |
|---|---|---|
| local | none | temp-directory store (§2) |
| dev | its own | dev's task role only; every object expires after 30 days |
| staging | its own | staging's task role only; never granted the prod bucket; every object expires after 30 days |
| prod | its own | prod's task role only; receipts archived after 2 years (§6) |

**Dev and staging delete everything after 30 days.** Testing will put far more
into dev than real use puts into prod, and nothing in dev is worth keeping. A
lifecycle rule expires every object 30 days after it was written, so dev's
storage bill stays flat however hard it's tested. A dev receipt older than that
shows its details but its file answers 404; the dev reset reseeds anyway.

**Staging, on its existing pattern.** Staging is a scrubbed copy of prod's
databases, rebuilt per deploy, whose job is catching a bad migration. Its copied
rows carry prod's `file_key` values, which name objects that exist only in the
prod bucket. The copy task does not copy objects: that would put prod's `pii`
files into a disposable environment, and the migration staging exists to test
never reads a file. So in staging a copied receipt's file route answers 404, and
files uploaded in staging land in staging's bucket and work normally.

**Self-hosted compose stack** (`deploy/docker-compose.prod.yml`) has no task
role. See Q-S3-4.

## 6. Infra, per environment (infra repo)

**Bucket.**
- S3 Block Public Access: all four settings on.
- Object Ownership: bucket owner enforced (ACLs disabled).
- Default encryption: SSE-S3, matching the agreement bucket (Board B17).
- Versioning: on.
- Bucket policy: deny any request without TLS (`aws:SecureTransport` false);
  deny object reads, writes and deletes to every principal except that
  environment's app task role and the account's admin role. The admin exception
  is the cleanup path for people: an admin can list, delete or restore objects in
  the console or CLI, as for any other bucket in the account.

**Who can touch the files.** The files are private to the organization's AWS
account; nothing outside it can read or list them. No access key is stored
anywhere. The app writes and reads with its ECS task role, whose credentials AWS
issues to the running container and rotates on its own; that role is the writer
of every object. People reach the bucket only through the account's admin role.

**Lifecycle.**

| Rule | dev, staging | prod |
|---|---|---|
| Current objects | expire 30 days after written | `receipts/`: move to Glacier Instant Retrieval 2 years after written. `mail-items/`: kept while held; Q-S3-2 decides expiry |
| Deleted objects (noncurrent versions) | expire after 1 day | expire after 30 days, the recovery window |
| Expired delete markers | removed | removed |
| Incomplete multipart uploads | abort after 1 day | abort after 1 day |

The multipart rule is housekeeping: the app never starts a multipart upload (a
10 MB put is single-part), so it only stops a stray one from billing.

**Archiving old receipts.** Glacier Instant Retrieval is the archive class that
still answers a normal read in milliseconds, so a 2-year-old receipt opens in the
app exactly as a new one does; storage costs about a sixth of the standard class,
with a small charge per read. The deeper classes (Glacier Flexible Retrieval,
Deep Archive) are cheaper still, but a read fails until someone requests a
restore and waits hours for it, so the app would need a "request this file" flow
it doesn't have. At hundreds of receipts a year the bucket holds well under a
gigabyte a year, so archiving saves cents; its value is a clean retention
policy, not cost. AWS doesn't transition objects under 128 KB by default, so
small text receipts stay in the standard class, which costs nothing that
matters. When files are finally deleted is a retention decision (Board B19).
- Incomplete multipart uploads abort after 1 day. The app never starts one (a
  10 MB put is single-part); this only stops stray uploads from billing.

**Task role** (the app's, per environment):

| Action | Resource |
|---|---|
| `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` | `<bucket>/receipts/*`, `<bucket>/mail-items/*` |
| `s3:ListBucket` | the bucket, conditioned on `s3:prefix` `receipts/` or `mail-items/`, so a missing key reads as not-found and not as a 403 (as the agreement role does) |

No `DeleteObjectVersion` and no bucket configuration rights. With versioning on,
an app delete only hides the object; the hidden copy stays for the recovery
window, and only the lifecycle rule or an admin removes it for good. So a
compromised app, or a bug, can't destroy a file outright. The app deletes
`mail-items/` objects on assign and discard, and a `receipts/` object only when
its own insert fails (§2); it never deletes a stored receipt's file.

**App env:** `RECEIPT_FILES_S3_BUCKET` and, until step 5, `RECEIPT_FILES_S3`.
`AWS_REGION` is already set.

## 7. Size limits

Unchanged, and still enforced by the app before any put; S3 has no per-object
cap that applies to a server-side put.

| Limit | Value | Where |
|---|---|---|
| One file | 10 MB | `MAX_FILE_BYTES`, at upload, import and mail intake |
| One upload request | 11 MB | `MAX_UPLOAD_BODY_BYTES` |
| Per person per day | 30 uploads, 100 MB | `enforceUploadLimits`, now summing `file_size` (with `octet_length(file_blob)` as fallback until the backfill) |
| Whole org per day | 500 MB | same |
| Held mail items | per-run held cap, per-run byte budget, global held ceiling | the mailbox-flooding hardening; unchanged by this move (Q-S3-3) |

## 8. PR split

Each PR is based on `main`; none stacks.

| # | PR | Contents | After |
|---|---|---|---|
| 1 | **Infra** (infra repo) | three buckets, policies, lifecycle, task-role grants, the two env vars set with the flag off | owner ruling |
| 2 | **Library** | the migration (§4 step 1, with `@sensitivity` tags and regenerated classifications), the file-store port, the S3, temp-directory and fake adapters, the flagged write path, the falling-back read path, limits on `file_size`, the mail-item deletes, the config-health row, tests. No boundary file changes. | #2239 merged (it writes `mailQueueService`); PR 1 applied in dev |
| - | flag on, dev then staging then prod | env change only | PR 2 rolled out there |
| 3 | **Backfill** | the copy and `--verify` script, its one-off task command, a runbook entry in `docs/ops/` | flag on in that environment |
| 4 | **Remove `bytea` reads** | read `file_key` only, drop the flag, stop selecting `file_blob` | verify clean in prod, in a release after PR 3's run |

The bulk-donation library also stores its uploaded CSVs as `bytea`
(`UploadedFile.fileBlob`). They stay in its database (decided, §9).

## 9. Questions

**For the Board.** On the Board questions page as B17, B18 and B19.

- **Q-S3-1 (Board B17). How the stored receipt files are encrypted.** Every file is
  encrypted on disk either way. The choice is who holds the key. Option A: AWS
  manages it invisibly; this is what the membership-agreement file uses, and it
  costs nothing. Option B: the organization has its own key in AWS, with its own
  access list; anyone reading a file then needs permission on both the files and
  the key, and every use of the key is logged. It costs about a dollar a month
  per environment. Recommendation: A, unless the Board wants personal data held
  to the stricter standard.
- **Q-S3-6 (Board B18). Whether the files can be read only from inside the organization's
  private network.** The app runs inside a private AWS network. If that network
  has a direct connection to the file store, the store can refuse every request
  that doesn't come through it, so a stolen credential is useless from anywhere
  else. Recommendation: yes, if the connection exists or can be added (it's free).
  Infra needs to say whether it exists today.
- **Q-S3-7 (Board B19). How long receipt files are kept.** Proposed: files move to cheaper
  archive storage after 2 years and remain viewable. Open: after how many years,
  if ever, are they deleted? Is a discarded receipt's file kept for the same
  period, or deleted sooner?

**For the owner.**

- **Q-S3-2. Mail nobody acts on.** "Held" means an emailed file from a sender the
  app can't match to a person: an unknown address, or one that fails the sender
  check. It waits on finance's mail-queue page until finance assigns it to a person
  or discards it. A known submitter who is over their daily limit is not held; that
  mail is deferred to a later day (see "Decided" below). Two questions:
  - Should a held item finance never assigns or discards be discarded
    automatically after some age? Proposed: 30 days. That's what clears a spam
    flood with no one working the queue. Today it would wait forever.
  - After a discard, the file stays hidden but restorable by an admin in the AWS
    console, for a window, then is gone for good. Nothing in the app shows or
    restores it. Proposed window: 30 days.
- **Q-S3-3. Global held ceiling after the move.** Waits on the intake caps, which
  are being redesigned (see "Decided" below). Once those are set: should the
  ceiling on held mail rise now that held files live in S3 and no longer grow
  checkin's database?
- **Q-S3-4. The single-server setup.** Besides AWS, the repo has a second way to
  run checkin: everything on one server under Docker
  (`deploy/docker-compose.prod.yml`), with its own Postgres. It's kept working
  (it gained its database roles recently), but I don't know whether anything
  real runs on it. On AWS the app gets bucket access from AWS itself, with no
  stored key; a single server has no such identity. So if receipts must work
  there, it needs either a stored AWS key limited to that server's bucket, or
  files kept on the server's own disk. If nothing real will run receipts on it,
  the answer is "not a target" and receipt uploads simply refuse there. Which is
  it? Asked on #2257.

**Decided.**

- **Bulk-donation uploads stay in their database** (was Q-S3-5): the files are
  small.
- **Owner rulings on mail intake, recorded here because they change what "held"
  means; their design belongs to intake (1265 §2a), not this doc:**
  - An unknown sender and a known submitter over their daily limit are different
    cases. Over-limit mail is someone catching up; it is processed on a later day
    automatically, or the same day if finance releases it. Unknown-sender mail
    waits until finance acts on it specifically.
  - Daily limits differ by role: program leaders and the Board can reach 25 in a
    day when catching up (one person has sent 20); for others, 5 is high.
  - An alias list lets a person own a second email address that attaches quietly
    to their account: mail from it is attributed to them, but it is not their
    sign-in address. The owner already does this for some vendors.
