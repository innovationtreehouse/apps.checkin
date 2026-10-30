# Receipt files: moving from the receipt database to a private S3 bucket

**Status: all Board rulings recorded (B17, B18, B19).** Amends #1265 §3 ("File storage").

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
  already stores (`Receipt.fileHash`, `ReceiptMailItem.attachmentHash`). The rows
  store hex and S3 takes base64 of the raw digest, so the S3 adapter re-encodes it
  on put. S3 refuses a body that does not match, so every stored object is
  verified at the moment it is written.

New columns on both `receipts` and `receipt_mail_items`:

- `file_key TEXT NULL`, tier **`pii`**. The key is opaque, but it is the handle
  to `pii` bytes, and when the file column is eventually dropped the file route's
  per-row tier check will key on it (§4). Tagging it `pii` now keeps that check at
  today's tier. The tag does not keep the key out of JSON: the stripper drops
  only fields a file route serves, and finance and the Board hold `pii` on the
  receipt routes. So every select that omits `fileBlob` today (the list shape,
  the mail-queue select) omits `fileKey` too, and the test that no JSON route
  returns a receipt file column covers `fileKey` as well.
- `file_size INT NULL`, tier `internal`. The daily byte limits sum
  `octet_length(file_blob)` today; with the bytes gone they sum this instead.

On a receipt, and on a held or deferred mail item, `file_key IS NULL` means "the
bytes are still in `file_blob`". That one column is the per-row switch the
migration turns (§4). A mail item that became a receipt has neither a key nor
bytes, and neither has one discarded before this move or ignored at intake: its
status says no file is kept.

## 2. Writes

The library gets one new port in `contract.ts`, a file store with `put`, `get`
and `delete`. The host binds it; `packages/receipt` takes no AWS dependency.

| `CHECKIN_ENV` | Binding |
|---|---|
| `dev`, `prod` (staging deploys with `CHECKIN_ENV=stg`, which reads as `prod`) | S3, bucket from `RECEIPT_FILES_S3_BUCKET`. Unset bucket: uploads and intake fail with 503, as the agreement sign endpoint does; the config-health page shows the gap. |
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

**Mail items.** Holding an item puts `mail-items/<uuid>`. Assigning one
runs the normal receipt insert, which puts `receipts/<newId>` from the same
bytes, and clears the item's `file_key` in the claim. Discarding leaves `file_key`
on the row, because it is the only record naming the object an admin would
restore; the row is never served, since reads take only held and deferred items.
After either commits, the app deletes the `mail-items/` object. In prod,
versioning keeps the deleted object for 30 days (§6), which is the window in
which an admin can restore a mistaken discard. Dev and staging keep it for 1 day;
nothing there is worth restoring. The key stays on the row after that window: it
is opaque, and PR 5's retention step (§7) clears it when it deletes the object.

**Cleaning up spam.** Mail from a sender the app can't attribute never becomes a
receipt; it's held in `mail-items/` until finance acts, so spam stays in the one
prefix the app already deletes from. Three things clear it:

- Finance discards an item on the mail-queue page, which deletes its file.
- Held items nobody acts on are discarded by the daily mail step 90 days after
  they were held, with an audit row, exactly as a finance discard is. So a flood clears
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

**Staging, on its existing pattern.** Staging is a scrubbed copy of prod,
rebuilt per deploy, whose job is catching a bad migration. Today the copy task
copies only checkin's own database, so staging's receipt database holds only
receipts uploaded in staging, and every file opens from staging's bucket.

Once the copy covers library databases, staging's receipt rows will carry prod's
`file_key` values, which name objects that exist only in the prod bucket. The
copy task will not copy objects: that would put prod's `pii` files into a
disposable environment, and the migration staging exists to test never reads a
file. So from then on a copied receipt's file route answers 404 in staging, and
files uploaded in staging still work normally.

**Self-hosted compose stack** (`deploy/docker-compose.prod.yml`) is not a target
for receipts. It has no task role and no bucket, so receipt uploads and mail
intake refuse there with 503, as any deployed instance without a bucket does
(§2). No stored-AWS-key path and no on-disk store is built for it.

## 6. Infra, per environment (infra repo)

**Bucket.**
- S3 Block Public Access: all four settings on.
- Object Ownership: bucket owner enforced (ACLs disabled).
- Default encryption: SSE-S3, matching the agreement bucket (Board B17, §10).
- Versioning: on.
- Bucket policy: deny any request without TLS (`aws:SecureTransport` false);
  deny object reads, writes and deletes to every principal except that
  environment's app task role and the account's admin role. The admin exception
  is the cleanup path for people: an admin can list, delete or restore objects in
  the console or CLI, as for any other bucket in the account.
- **Reads only from inside the organization's network** (Board B18). The app's
  private AWS network reaches S3 through a gateway endpoint (a free, direct route
  from that network to S3). The bucket policy denies `s3:GetObject` to every
  principal, the admin role included, unless the request arrives through that
  endpoint (`aws:SourceVpce`). A stolen credential, or the admin console from a
  laptop, can't read a file. The admin role can still list, delete and restore
  objects from outside, because none of those returns a file's contents; to see a
  file, a person opens it in the app. The backfill and `--verify` run as ECS tasks
  inside the network (§4), so they read through the endpoint too. Infra adds the
  endpoint where it doesn't exist yet; the deny goes on only once it does, or
  every read fails.

**Who can touch the files.** The files are private to the organization's AWS
account; nothing outside it can list them, and nothing outside its network can
read them. No access key is stored
anywhere. The app writes and reads with its ECS task role, whose credentials AWS
issues to the running container and rotates on its own; that role is the writer
of every object. People reach the bucket only through the account's admin role.

**Lifecycle.**

| Rule | dev, staging | prod |
|---|---|---|
| Current objects | expire 30 days after written | `receipts/`: move to Glacier Instant Retrieval 2 years after written; never expired by a rule, the app deletes them (§7). `mail-items/`: no rule; the app deletes on assign or discard, and held items auto-discard at 90 days (§2) |
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
matters. When files are finally deleted is §7.

**Task role** (the app's, per environment):

| Action | Resource |
|---|---|
| `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` | `<bucket>/receipts/*`, `<bucket>/mail-items/*` |
| `s3:ListBucket` | the bucket, conditioned on `s3:prefix` `receipts/` or `mail-items/`, so a missing key reads as not-found and not as a 403 (as the agreement role does) |

No `DeleteObjectVersion` and no bucket configuration rights. With versioning on,
an app delete only hides the object; the hidden copy stays for the recovery
window, and only the lifecycle rule or an admin removes it for good. So a
compromised app, or a bug, can't destroy a file outright. The app deletes
`mail-items/` objects on assign and discard, a `receipts/` object when its own
insert fails (§2), and a stored receipt's file only when its retention date has
passed (§7).

**App env:** `RECEIPT_FILES_S3_BUCKET` and, until step 5, `RECEIPT_FILES_S3`.
`AWS_REGION` is already set.

## 7. Retention

The Board set how long receipt files are kept (B19):

| Receipt | File deleted |
|---|---|
| Approved | 6 years after that fiscal year's Form 990 deadline, plus 1 year |
| Rejected or discarded | 1 year after it was rejected or discarded |
| Not yet decided | never, while it waits |

**Why those numbers.** The IRS can generally assess tax for 3 years after a
return is filed, and for 6 years if gross income is substantially understated.
The Form 990 for a fiscal year is due on the 15th day of the 5th month after the
year ends; a return filed early counts as filed on that day. The Board chose the
6-year limit and added a year.

**Computing "delete after" for an approved receipt.**

1. Take the receipt's date. If it has none, take the day it was approved.
2. Find the fiscal year containing that date. The fiscal year runs July 1 to
   June 30.
3. The 990 deadline is the 15th day of the 5th month after June 30: November 15.
4. Delete after = the deadline plus 7 years.

A receipt dated anywhere from July 1, 2025 to June 30, 2026 belongs to that
fiscal year, whose 990 is due November 15, 2026, so its file is deleted after
November 15, 2033. Every approved receipt in one fiscal year shares one date.

The fiscal year end is a constant in the code, with a comment naming it, not a
setting: it changes only if the organization changes its fiscal year, which is a
code change anyway.

The deadline is the unextended one, as the ruling states. A 6-month extension
moves the IRS limit 6 months later, which the extra year still covers.

**Who deletes.** A daily retention step in the app, not an S3 lifecycle rule: the
deletion depends on the receipt's state and dates, which live in the database and
not on the object. For each receipt past its date, the step deletes the
`receipts/` object, clears `file_key`, and writes an audit row. A discarded mail
item's leftover key is cleared by the same step when its object's window has
closed. The receipt row
itself stays: it is part of the books. The file route then answers 404, as for
any missing file (§3). The step computes the date from the receipt's current
state each run, so a receipt that is reopened stops counting down.

In prod, S3 keeps the deleted version for 30 days (§6), then removes it. Until the
`file_blob` column is dropped (§4), the step also nulls that row's `file_blob`;
this is the one place the plan removes bytes from the database, because the rule
requires the file gone.

The step ships after the bytes have moved (§9, PR 5).

## 8. Size limits

Unchanged, and still enforced by the app before any put; S3 has no per-object
cap that applies to a server-side put.

| Limit | Value | Where |
|---|---|---|
| One file | 10 MB | `MAX_FILE_BYTES`, at upload, import and mail intake |
| One upload request | 11 MB | `MAX_UPLOAD_BODY_BYTES` |
| Per person per day | 30 uploads, 100 MB | `enforceUploadLimits`, now summing `file_size` (with `octet_length(file_blob)` as fallback until the backfill) |
| Whole org per day | 500 MB | same |
| Held mail items | per-run held cap, per-run byte budget, global held ceiling of 500 | the mailbox-flooding hardening; unchanged by this move, the 500 ceiling included |

## 9. PR split

Each PR is based on `main`; none stacks.

| # | PR | Contents | After |
|---|---|---|---|
| 1 | **Infra** (infra repo) | three buckets, policies, lifecycle, task-role grants, the S3 gateway endpoint where missing and the network-only read rule (§6), the two env vars set with the flag off | Board B17 |
| 2 | **Library** | the migration (§4 step 1, with `@sensitivity` tags and regenerated classifications), the file-store port, the S3, temp-directory and fake adapters, the flagged write path, the falling-back read path, limits on `file_size`, the mail-item deletes, the config-health row, tests. No boundary file changes. | PR 1 applied in dev |
| - | flag on, dev then staging then prod | env change only | PR 2 rolled out there |
| 3 | **Backfill** | the copy and `--verify` script, its one-off task command, a runbook entry in `docs/ops/` | flag on in that environment |
| 4 | **Remove `bytea` reads** | read `file_key` only, drop the flag, stop selecting `file_blob` | verify clean in prod, in a release after PR 3's run |
| 5 | **Retention** | the daily retention step (§7) and the 90-day held-mail auto-discard (§2), each with its audit row, tests | PR 4 rolled out |

The bulk-donation library also stores its uploaded CSVs as `bytea`
(`UploadedFile.fileBlob`). They stay in its database (decided, §10).

## 10. Questions

**Decided.**

- **Who holds the encryption key** (Board B17; was Q-S3-1): AWS manages it
  (Option A), as for the membership-agreement file, at no cost. Every file is
  encrypted on disk. The Board did not take Option B, the organization's own key
  with its own access list. Designed in §6.
- **Network-only reads** (Board B18, 2026-10-27; was Q-S3-6): receipt files are
  readable only from inside the organization's network. Designed in §6.
- **Retention** (Board B19, 2026-10-27, with the owner choosing the 6-year limit;
  was Q-S3-7): approved receipts are kept until 6 years after their fiscal
  year's Form 990 deadline, plus 1 year; rejected and discarded receipts are
  deleted after 1 year. Designed in §7.
- **The fiscal year end** (was Q-S3-8): the fiscal year runs July 1 to June 30,
  so the Form 990 is due November 15 (§7).
- **Mail nobody acts on** (owner, 2026-10-17; was Q-S3-2): a held item nobody
  assigns or discards is discarded automatically at 90 days (§2). A discarded
  item's file stays restorable by an admin for 30 days in prod, then is gone (§6).
  "Held" means an emailed file from a sender the app can't match to a person; a
  known submitter over their daily limit is deferred, not held (below).
- **Global held ceiling** (owner, 2026-10-17; was Q-S3-3): stays at 500 after the
  move (§8).
- **The single-server setup** (owner, 2026-10-17; was Q-S3-4): not a target for
  receipts. Receipts refuse to store outside AWS (§5).
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
  - Extra sending addresses (aliases) for a person are ruled in
    `docs/rules/people-households.md`: finance or the Board record them, and one
    counts only after finance or the Board approves it from its first mail.
