# Receipts: porting `receipt-app`, `ocr-function` and `receipt-load-app` into checkin

## Problem

Anyone who buys something for the organization, on the organization's card or out
of their own pocket, has to hand over a receipt. Today that happens in a separate
application with its own login, which the organization is retiring. The receipt is
where the purchasing pipeline starts: its lines tell inventory what arrived and tell
finance what was spent. Until it moves, the pipeline that has already moved
(catalog, inventory, expense) has nothing feeding it except hand entry, and a
person who paid out of pocket has no place in checkin to see whether they have been
paid back.

## Objective

A person submits a receipt in checkin, by photo, PDF or text, and either types the
details or has them read automatically. Duplicates and arithmetic mismatches are
caught for a human to resolve; tax, stale and future-dated receipts go to finance
for a recorded sign-off; a finalized receipt feeds the rest of the pipeline in
process. The submitter can see their own receipts, where each one stands, and
whether a reimbursement has been paid.

## Executive summary

- **Submitters** (anyone who can view the catalog, §6) get an Upload page and a
  "My receipts" list showing each receipt's state and, for out-of-pocket purchases,
  whether QuickBooks shows them paid back. The source never showed that (§4).
- **Finance** gets the review queue (tax / age / future-date exceptions),
  duplicate and validation queues, all under the
  `FINANCE` role the expense port introduces.
- **Operators** add one secret, `ANTHROPIC_API_KEY`, and no new service: OCR is a
  direct API call from the app process, and receipt files are stored in the
  receipt database (§3).
- **Not changed:** the receipt state machine, duplicate rules and the
  `CompletedReceipt` contract port verbatim, plus one optional in-kind mark
  (§4). In-kind donations as a whole belong to donations (§5).
- **Two intake paths (owner decision):** upload covers the backlog; a Gmail
  inbox is the ongoing intake, built as its own phase G after S/B/W (§2a).

Everything #1286, #1287 and #1272 settle is assumed, not restated: in-process
library (`@inventory/receipt`), own database (`RECEIPT_DATABASE_URL`), checkin's
security regime, retired source auth, injected `Org` and `Person` principal,
per-crossing ports, no hosted `/api/internal`.

**Domain rules relied on:** `docs/rules/finance-payments.md` (a financial control
is a flag a person signs off, recorded; nobody decides a matter they are
conflicted in, *Ethics Policy Art. III §III.5*; SaaS vendors must be SOC 2 and
ISO 27001 compliant, *Definitions Policy Art. III, "Suitably Secure Electronic
Means"*; payment itself happens in the books, by analogy to the refund
assumption). `docs/rules/principles.md` (least privilege; fail closed).

---

## 1. What the source actually is

Reading the code changed the scope in five places. Each is a delta below.

| Finding | Where | Consequence for the port |
|---|---|---|
| **Auto-OCR at upload is not wired.** The upload form's "Auto OCR" toggle hides the detail fields but submits to the same endpoint, whose schema requires retailer and at least one line, so it 400s. OCR runs only from `retry-ocr`, which needs a receipt already in `ocr_failed`, a state nothing enters. | `ReceiptUploadPageClient.tsx`, `UploadBodySchema`, `receiptService.retryOcr` | OCR-at-intake is **net-new wiring** onto states the machine already defines (`auto_upload → uploaded / ocr_failed`). |
| **The S1 push failure is swallowed.** `finalizeReceipt` sets `receipt_finalized`, then `.catch(console.error)` on the push. A failed push leaves a finalized receipt nobody downstream ever sees. The manual `push-to-inventory` route re-sends but is not idempotent (its own `concurrency.test.ts` pins duplicate pushes). | `receipt-flow.ts`, `concurrency.test.ts` | Record push outcome; retry in the daily catch-up step and manually (§4). |
| **No "paid back" state anywhere.** `submitter_review` confirms *who* is owed; nothing records that they were paid. Expense carries `needsReimbursement` / `reimbursementFor` as display fields only. | receipt + expense schemas | FR3's port requirement does **not** survive as-is; the status is read from QuickBooks (§4). |
| **No Gmail-inbox monitor.** The nearest thing is `receipt-load-app/scripts/mbox-extract.py`, an offline splitter for an exported mailbox used by the one-time backfill. `ocr-function` is a CLI that runs the Claude **Agent SDK** on a local `.eml` with the operator's Claude Code login. | `receipt-load-app/scripts`, `ocr-function/` | Gmail intake is net-new (§2a). `ocr-function` is **not ported**: the in-app OCR path already does the same job with the plain SDK. |
| **No in-kind identification.** Nothing in receipt, workflow-mapping or expense mentions in-kind or donations. | grep across the fleet | FR5 has nothing to port; the in-kind mark is net-new (§4). |

Dropped rather than renamed: `SettingsData` (both fields are remote-service URLs),
the `system-data` route and page, and `local-owners` (proxies the retired auth
server; no page calls it). So of the owner-approved renames only
`OrgSettings → ReceiptOrgSettings` ships; `ReceiptSettingsData` stays reserved.
`receipt-load-app` is a temporary backfill loader (two routes; §7).

---

## 2. Intake

**Upload** keeps the source's multipart `POST /api/receipts/upload`. Details
present means **manual**: insert at `uploaded`, run the pipeline (unchanged). File
only means **auto**: insert at `auto_upload`, call OCR in the same request (§3),
then `OCR_SUCCEEDED → uploaded` or `OCR_FAILED → ocr_failed`, from which the
submitter retries or types the details. `UploadBodySchema` splits into the two
shapes rather than loosening one.

**Limits the source lacks** (its `upload-hardening.test.ts` records both): a 10 MB
file cap and a 200-line cap, 400 on breach; 10 MB stays inside the API's 32 MB
request limit after base64. Accepted types add `image/webp`. **The type is checked
by content, not the declared `Content-Type` or extension:** images and PDF must
match their magic bytes (JPEG, PNG, GIF, WebP, PDF), and `text/plain` (a manual
upload or an email body, §2a) must be valid UTF-8 with no NUL bytes, else 400. The
allowlist is the source's accepted types plus WebP, nothing more. The stored file is the bytes as uploaded; the app never
modifies an image (owner decision: no EXIF stripping, no redaction).

**Duplicate detection ports verbatim.** SHA-256 file hash, then the composite
`(retailer, date, total)`, then `(retailer, orderNumber)`, then
`(retailer, receiptNumber)`, each org-scoped. `(orgId, fileHash)` stays a
**non-unique index**: a unique constraint would reject the second upload before the
flow could flag it for a human (Inventory `BYDESIGN.md`, regression pinned by
`upload.test.ts`).

**The concurrent double-upload race (`CONCURRENCY.md` §3) is fixed in S, test
first.** The source checks the hash only after the row is inserted and compares
against every other row, so the outcome of two identical uploads depends on
timing: both can be flagged as each other's duplicate, or, when one request is
slow to insert, neither is. The fix is in the flow, not a constraint:

- In one transaction, take `pg_advisory_xact_lock` keyed on a hash of
  `(orgId, fileHash)`, look for an existing row with that hash, and insert the new
  receipt with `duplicateSuspectReceiptId` set to it. The lock serialises only
  identical files in one org, so the second upload always sees the first.
- The pipeline's hash step reads that stored suspect instead of re-querying, so a
  receipt is only ever a duplicate of one that existed before it. The composite,
  order-number and receipt-number checks are unchanged; concurrently they can
  over-flag both receipts but cannot miss, which leaves the decision with a person.
- The failing concurrent test comes first: two identical uploads at once, exactly
  one ends `duplicate_flagged`.

**Suspected source bug in the same step: clearing a duplicate may not stick.**
`clear-duplicate` stamps `duplicateFlagClearedAt` and re-runs the pipeline, but
`checkDuplicate` never reads that stamp, so while the original exists the hash
check should flag the receipt again. The source's tests seed a flagged receipt
with no original, so they cannot see it. S writes that test first as well; if it
fails, the hash step skips a receipt whose flag a person has cleared.

---

## 2a. Gmail intake (phase G, net-new)

Upload covers the backlog; a mailbox people forward receipts to is the ongoing
intake (owner decision). Nothing in the source does this, so it is designed here.

**Mailbox access, on the QuickBooks pattern (#1272 §9).** One Google mailbox
at an address in the organization's own domain (owner decision; the name is a
deploy-time value, `RECEIPT_MAILBOX_ADDRESS`) and one OAuth grant with the `gmail.readonly` scope only: the app never
labels, moves or deletes mail. An operator runs the consent once from a CLI with
the write grant; the resulting refresh token is seeded into a secret only an
**Infra-owned refresher** can read and write; the refresher publishes a
short-lived access token to a second secret, and the app has read-only IAM on that
one. No OAuth route in the app, no token in Postgres. Static client credentials are
Infra env for the refresher and consent tool, not the app.

**Trigger: a step inside the existing daily `/api/cron/reconcile-shopify`
handler, not Pub/Sub push.**

| | Existing daily cron | Gmail push (Pub/Sub) |
|---|---|---|
| Route | none new; `/api/cron/*` additions are frozen legacy-authz, so it rides an existing handler, as income does | needs a new machine webhook route, which `check-route-coverage`'s `new-route-old-authz` ratchet blocks |
| Database wakes | shares the one daily wake that handler already causes (scale-to-zero Aurora) | one wake per arriving email |
| Upkeep | none | `users.watch` expires after 7 days and must be renewed by another job |
| Latency | a receipt appears within a day | minutes |

A day's latency is fine for receipts; nobody is waiting on one at the door. The
step runs in its own `try/catch`, so a Gmail failure never fails the reconcile, and
it is skipped when the access-token secret is unset (local, flow tests). The
constraint to state plainly: no machine-facing route can be added to checkin
today, so push is not an option without first changing that rule.

**Reading the mailbox.** Each run lists messages from the last 3 days. A message
with attachments of an accepted type (§2) yields one receipt per attachment. A
message with none (an order confirmation, owner decision) yields **one receipt
whose file is the body**:

- The body's `text/plain` part when Gmail has one; otherwise the `text/html` part's
  source, stored as **`text/plain`**. OCR reads it as text, as the source's `.eml`
  path did. Storing it as HTML is ruled out: the file is served from checkin's
  own origin, so stored HTML would be one header mistake away from live script
  there (§3 shows text only as escaped text).
- The ledger hash for a body is the hash of that stored text.
- When a message has attachments, its body is ignored; it is usually covering
  text.

The 3-day
window plus the dedupe ledger makes a missed run harmless with no stored cursor.
`ponytail:` ceiling is a cron outage longer than 3 days; widen the window if one
happens.

**Message to receipt.**

- **Ledger:** `ReceiptMailItem` keyed unique on `(gmailMessageId, attachmentHash)`.
  An item already in the ledger is skipped, so re-reading a message is free.
- **Sender authentication: DMARC alignment, not "SPF or DKIM".** SPF
  authenticates the envelope sender, not `From`, so a pass proves nothing about who
  the message claims to be from. The step accepts a sender only when:
  - it reads the **topmost** `Authentication-Results` header, and only if that
    header's authserv-id is `mx.google.com`; every other `Authentication-Results`
    header (lower in the message, or from any other server) is ignored, since a
    sender can write those;
  - that header carries `dmarc=pass`, so SPF or DKIM passed **aligned** with the
    `From` domain;
  - the message has exactly one `From` header containing exactly one addr-spec;
    that address is matched, never the display name;
  - headers inside a forwarded or attached message (`message/rfc822` parts, quoted
    "From:" lines in the body) are never read for identity.
- **Sender to person:** the authenticated `From` address must match a `Person`
  email, and that person must be in the submitter audience (§6). Then the
  attachment enters the **same upload pipeline** in auto mode (OCR, the duplicate
  check including the §2 lock) with that person as uploader.
- **Anything else goes to a `FINANCE` queue, never dropped:** unknown sender,
  sender outside the audience, failed or missing DMARC alignment. The item keeps its file until
  finance assigns an uploader (then it enters the pipeline as above) or discards it.
- **Fields email cannot carry:** reimbursement, in-kind mark, donor. A mailed
  receipt therefore always stops at `submitter_review` (guard extended from
  "needs reimbursement and not reviewed" to "came by email or needs reimbursement,
  and not reviewed"), where its uploader sets those fields and confirms. Without
  that stop, it would finalize and push as a plain purchase before anyone could
  say it was owed or donated. `Receipt.intakeSource` (`upload` / `email` /
  `import`) carries the distinction.

**Sensitivity.** Stored per item: Gmail message id, attachment hash, received
time, sender address, status, and the file until it becomes a receipt. **Never
stored:** subject, other recipients, any other header, and the body, **with one
exception**: when the body itself is the receipt document (a message with no
attachment), it is stored as that receipt's file, at the same tier and behind the
same file route as an uploaded file, and nowhere else. The sender address is
`pii`, read by `FINANCE` only; a held file is tiered like the receipt file and
leaves only through the file route (§3). Every view of the mail queue writes an
audit row (§6).

---

## 3. OCR, secret, and file storage

**Where it runs.** In process, in the library's `ocr.ts`, called from the upload
and `retry-ocr` routes; no Lambda, no queue, at hundreds of receipts a year. The
request waits the seconds-to-tens-of-seconds a vision extraction takes. A process
that dies mid-call leaves the receipt in `auto_upload`; the daily catch-up step
(§4) moves any such row older than ten minutes to `ocr_failed` ("interrupted"),
where the submitter can retry. `ponytail:` ceiling is a day stuck in "Reading";
the submitter can discard and re-upload sooner.

**OCR output is advisory.** The receipt text is untrusted input to the model, so
what comes back is a proposal for a person to confirm, never an authority. OCR
fills the receipt's own details (retailer, date, totals, lines, `isDelayed`). It
never sets the reimbursee, the QuickBooks vendor, or `needsReimbursement`; only a
person sets those, in the upload form or in `submitter_review`. **The file goes to
Anthropic as bytes** (base64 in the request), never as a URL the API would fetch.

**Call shape** (re-checked against the current API, not the source's):

| | Source | Port |
|---|---|---|
| Model | `claude-sonnet-4-6` | `claude-opus-5-5`; `output_config.effort` set explicitly to `medium` (its default) and tuned against a fixture eval before anyone lowers it |
| Forcing JSON | `tool_choice: { type: "tool" }` | **Structured outputs** (`output_config.format` with the existing extract schema). Forced `tool_choice` returns 400 on Opus 5.5. |
| Refusals | unhandled | `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`); a final `stop_reason: "refusal"` is an OCR failure |
| Money | `receiptTotalText` parsed in preference to the number | kept verbatim (`parseMoney`); it guards the `$69.89 → 6989` drop |

`receipt-load-app`'s per-mode model routing and `claude -p` backend are not
carried; one model is simpler at this volume, and the CLI bills a personal plan.

**Failure and retry.** The SDK's own retry (2 retries on 408/409/429/5xx and
connection errors; client timeout set to 120 s) is the only automatic one. Any
other failure (non-retryable error, refusal, unparseable or incomplete result)
lands the receipt in `ocr_failed` with the reason in `validationNotes`, for a human
to retry or type. Partial results are never kept, as in the source.

**Secret.** `ANTHROPIC_API_KEY`: a new Infra-managed secret, injected as an env var
like checkin's other third-party keys, with the standalone-secret-shell and
two-branch phasing of #1286 Track 6. The app only reads it. A dedicated Anthropic
workspace with a monthly spend limit caps the cost of a bug.

**Mock.** The adapter is chosen by `CHECKIN_ENV`, never by whether a key is set
(*Principle: fail closed*): `local` binds a deterministic fixture mock (flow tests,
dev seed), following `docs/ops/dev-instance.md`'s Zoho/Shopify pattern; `dev`/`prod`
bind the real client, and a missing key there fails OCR into `ocr_failed` ("not
configured") while manual entry keeps working.

**File storage: `bytea` in the receipt database, as the source does.** Hundreds of
files a year is under a gigabyte annually; lists already `omit` the blob. The file
column (and a held mail item's file) is `secret` tier.

**Files are not JSON (plan rule 7).** `GET /api/receipts/[id]/file` is built on
the **H6 file-route primitive** (`defineFileRoute` / `fileHandler`: authorize, the
per-row scope check, then a streamed body), registered like any route. Every
response carries the stored type, `nosniff`, and `Content-Security-Policy:
sandbox`, so nothing the file contains can run as checkin's origin. By type
(owner decision):

- **Images and PDFs display in the browser** (`Content-Disposition: inline`).
  Their content was checked against its magic bytes at upload (§2), so the stored
  type is the real one.
- **Text is shown escaped, never served as a page.** The receipt page renders a
  `text/plain` file as escaped text (a React text node in a `<pre>`, which escapes
  by default), so HTML source from an email body displays as visible tags. The
  file route itself sends text only as `Content-Disposition: attachment`.

Every view or download writes an audit row (§6). A test asserts that no
JSON route's response contains a `secret`-tier receipt column. H6 is a boundary PR
that lands before this lane's B and W.
`ponytail:` ceiling is DB size and backup time; upgrade path is a private S3 bucket
read with the task role, as `agreementDocument.ts` does.

---

## 4. The state machine, reimbursement status, and exceptions

**The machine ports verbatim.** `uploaded` runs the guard chain *duplicate → math
invalid → needs submitter review → needs financial review → finalized*;
`receipt_finalized`, `discarded`, `rejected` are terminal. Reject-with-reason has
an endpoint today; the e2e plan's "no REJECT endpoint" finding is stale.

**Push outcome is recorded.** New `Receipt.pushedAt`, stamped when S1 returns. A
failed push leaves it null with an audit row; the daily catch-up step re-pushes
every finalized, unpushed receipt, and the manual `push-to-inventory` button does
one at once. Safe because S1 is idempotent on `receiptId` (§7).

**Catch-up steps: no database at boot, no new schedules** (plan rule 5). The
library reads nothing at app start. Every sweep is a `try/catch` step inside the
existing prod `/api/cron/reconcile-shopify`, beside income and the Gmail step
(§2a), so one failing step never fails the others or the reconcile:

1. OCR-interrupted sweep (`auto_upload` older than ten minutes → `ocr_failed`).
2. S1 re-push of finalized receipts with `pushedAt` null.
3. X13 re-send for receipts with `donorSyncedAt` null.
4. Gmail intake (phase G).

Each step is idempotent, capped per run, and returns counts only (swept, pushed,
re-sent, mail items read, failed) — no ids, names, addresses or amounts in the
cron response. Work done inside a user request (OCR, the first push, the first
X13 call) stays in the request; the steps only catch what that missed.

**Reimbursement status (FR3 port requirement).** What the backlog row believed
does survive: a submitter sees every receipt they uploaded (`listForOrg` filters to
the uploader), sets and confirms who is owed in `submitter_review`, and can discard
their own. "Did I get paid back?" has no answer anywhere.

**QuickBooks is the system of record for reimbursement (owner decision)**, whether
the payment happened years ago (backfill) or happens after this receipt. So the
app records nothing about it: no "mark reimbursed" action and no reimbursed columns
on `Receipt`, the same rule finance-payments sets for the store ("no payment fact
is authored here"). "My receipts" shows *Reimbursement: not yet paid / paid on
<date>* beside the state, read through a port:

- `ReimbursementStatus { forReceipts(receiptIds): Promise<Map<receiptId, { paidOn: string | null }>> }`
  in `contract.ts`, asked only for the caller's own receipts with
  `needsReimbursement`.
- This is crossing **X12** (receipt to expense, sync read), owned by the expense
  lane (L3) on L4's QuickBooks client. A reimbursement is a QuickBooks **Bill**
  to the reimbursee, which the system creates and **never pays**; finance pays it
  in QuickBooks. For a new receipt, `paidOn` is the date of the Bill's linked
  BillPayment. For a backfilled receipt, it is the date of the hand-booked
  transaction the receipt matched, so X12 reads `ReceiptDetail.qbEntity` and
  `qbTxnId`, which is why both columns stay. Gates: L3 W, QB-1/QB-2, L8 W.
- **Inert at S:** returns `paidOn: null` for every receipt, so the view says "not
  yet paid" until X12 flips. It never claims a payment.

Reimbursement is not a machine state: it is outside the intake flow and outside
the app.

**History has a limit, and it is expected.** A past reimbursement that was booked
in QuickBooks without a receipt never appears in "My receipts": the list shows
receipts, and that payment has none.

**The reimbursement option is hidden for non-adults (owner decision).** The
submitter audience (§6) can include minors. For an uploader who is not an adult,
the upload form and `submitter_review` do not offer "I paid for this myself", and
the service rejects `needsReimbursement` from them. A minor's receipt is always a
plain purchase or in-kind.

**"My receipts" view (owner decision).** One list of the uploader's receipts, each
row showing its intake state and, when `needsReimbursement`, the QuickBooks paid
status. A receipt is **complete** when it is `discarded` or `rejected`, or
`receipt_finalized` and either not owed (`needsReimbursement` false, which covers
every in-kind receipt) or shown paid by QuickBooks. A finalized receipt still
awaiting reimbursement stays visible until paid. A **"Hide completed"** checkbox
removes complete receipts from the list; it starts unchecked and is not
remembered. Complete is derived from the state and the paid status, so nothing
new is stored. **Until X12 is live, every owed receipt stays in "My receipts"**,
even with "Hide completed" ticked. That is the safe direction: an unpaid
reimbursement is never hidden by mistake.

**Tax exceptions (FR4).** `ReceiptOrgSettings` keeps the tax-exempt and age-limit
flags; tax on a tax-exempt org, a receipt past the age limit, or a future date
sends it to `financial_review` with reasons shown. Delta: **approve takes a note,
required when a reason is tax**, stored on the audit row. The source approves
silently, so nothing records why tax was accepted; that note is FR4's "tax
explanation". QB-linked backfill keeps its waivers (no submitter step, no age gate).

**Self-decision is refused.** A `FINANCE` person cannot approve or reject their
own upload (409), as finance-payments already refuses deciding a
scholarship for one's own household (*Ethics Policy Art. III §III.5*). The source
allows it. Household conflicts are left to expense's COI flag (#1272 §6), which
reviews the same money downstream.

**Backorder deferral (FR6)** is a per-line `isDelayed` flag here, set by hand or by
OCR and carried on S1. The deferral itself is local-inventory's receive queue,
reached via the orchestrator's S3 push (#1287 §8c). Nothing else changes.

**In-kind mark (FR5, owner decision).** A donated item that comes with paperwork
goes through this pipeline like a purchase; only its money side differs, and the
orchestrator routes that to donations (bulk-donation design §2.4, crossing X9)
instead of expense. This lane's part is the mark and nothing else:

- The uploader ticks "this is a donation" at upload (both modes); editable while
  the receipt is editable; audit-logged when changed.
- `Receipt.isInKind`, carried as `CompletedReceipt.isInKind:
  z.boolean().optional().default(false)`, the same shape as `backfill`; name
  agreed with the workflow-mapping design. That design's S PR adds it to
  `receipt-types` with a MINOR bump to 1.1.0; this lane only fills it in.
- OCR is unchanged: the paperwork is the same kind of document.
- **Financial review (owner decision):** the tax check does not apply to an
  in-kind receipt (the org paid no tax); the age-limit and future-date checks do.
- **Donor identity is captured at upload (owner decision).** When the mark is
  set, the uploader picks **"I am the donor"** (names filled from the uploader's
  `Person`) or **enters the donor's name** (`donorFirstName`, `donorLastName`,
  optional `donorCompanyName`, the field set bulk donation already uses). One of
  the two is required (owner decision): upload validation rejects an in-kind
  receipt with no donor, and there is no leave-blank option.
  **The donor does not travel in `CompletedReceipt`** (owner decision). Receipt
  sends it straight to donations over crossing **X13** (§7), keyed on
  `receiptId`; the orchestrator's X9 stays money-only, and donations joins the
  two on `receiptId`. OCR does not fill it: the paperwork is the donor's
  purchase receipt, which names the store, not the donor.
- `Receipt.donorSyncedAt` marks donations as up to date. It is cleared on every
  donor or in-kind change and stamped when X13 returns; the daily catch-up step
  re-sends every receipt where it is null and a donor was ever sent, as for S1
  (§4).
- Donor names are **`pii`** on `Receipt`, matching bulk donation §4: read only by
  `FINANCE` (and by `BOARD` if donations' gate is reused). The uploader can enter
  them but does not read them back: the submitter list and detail views return the
  receipt without donor fields. Donor contact details for an acknowledgement are
  the in-kind design's to add.
- **No reimbursement (owner decision):** an in-kind receipt cannot set
  `needsReimbursement`; the donor paid, not the uploader. So it never enters
  `submitter_review` for a reimbursee, and it has no paid status.
- **Submitter view (owner decision):** no separate donation status; it shows its
  intake state and is complete once finalized (§4, "My receipts" view).

---

## 5. Out of scope

- **In-kind beyond the mark (FR5).** Valuation, donor acknowledgement and the
  no-receipt catalog picker belong to the donations lane (owner decision).
- **Card-statement reconciliation (FR8)**, net-new, its own issue.
- **`ocr-function`** (§1).

---

## 6. Roles and sensitivity

| Action | Source guard | checkin |
|---|---|---|
| Upload; see own receipts; act on own receipt (submitter review, edit while editable, discard own, retry OCR) | any org role; `canActOnReceipt` = uploader | **anyone who may view the catalog** (owner-decided): the `catalog-viewer` audience of #1286 (any RBAC role holder, program leader, or volunteer). |
| Review queue; approve / reject financial; see all receipts and files; clear duplicate; discard any; audit log; restart flow; import | `isFinance`, `isOrgManager` | **`FINANCE`** (org-manager collapses onto it, as #1272 did) |
| Org receipt settings (tax-exempt, age limit) | `canEditOrg` | **`FINANCE`** |
| `isAdmin` | blocked from receipts | `SYSADMIN` gets nothing extra (finance-payments excludes sysadmins from Finance Ops) |

`FINANCE` comes from lane L3's role PR. The receipt W PR needs it on `main`; B does
not (an unused `defineRoute` is inert).

**Sensitivity follows expense (#1272 §5), not catalog.** `internal` for amounts,
retailer, receipt/order numbers, line text, `reimbursementFor`, every actor
id (`uploadedByUserId` becomes `Person.id`), audit values and QB linkage. The
**file is `secret`** (names, delivery addresses, card last four): never in a JSON
response, only the H6 file route (§3). `reimbursementFor` moves to `pii` if a
route ever returns contact details beside it.

**Sensitive reads are audited.** Every file download (submitter or finance) and
every view of the mail queue writes an audit row: actor, receipt or mail-item id,
action, time. The audit payload carries no PII and no file bytes.

**Narrow reads at the handler, no scopeBindings**, as #1272 §5 settled: a
submitter's list and detail calls filter `WHERE uploadedByUserId = principal.id`;
finance reads the org. Submitter routes reuse the existing `catalog-viewer`
`authorize` token, so no new token grammar enters the boundary.

**A caller with no integer id is unauthenticated** (boundary rule 6). Receipt's
checkin-side adapter `getPrincipal()` returns `null` unless
`typeof user.id === "number"`, as `checkin-app/src/lib/catalog/configure.ts`
does, and the submitter filter reads the id only from that principal. Prisma
drops a `where` key whose value is `undefined`, so an id-less session (a JWT
whose re-sync missed after a person merge or delete) would otherwise list every
receipt in the org. The filter takes the id through `callerId(auth): number`,
which throws on anything but an integer.

**Never authorize on `localUserId`.** The `receipt-types` contracts carry a
caller-asserted `localUserId`; receipt never reads it for authorization, for
"my receipts", or for attribution. The uploader is always the principal.

| Test | Expect |
|---|---|
| id-less session (`user.id` undefined) calls the submitter list or detail route | 401, never a list |
| a payload `localUserId` names another person | ignored; uploader and filter come from the principal |

---

## 7. Crossings (Wave 3)

Every crossing this lane calls ships its port and an inert adapter in **S**;
flipping one is a one-line binding change in `configureReceipt()`.

### X6: S1 receipt push → workflow-mapping

**The workflow-mapping design (#1289 §8a) owns the S1 contract**; this lane is the
caller and adopts it as written:

1. **Callee:** `ingestReceipt(receipt: CompletedReceipt)` from `@inventory/workflow-mapping`, returning `{ id, state, created }`. The receipt library's `ReceiptSink` port binds to it in `configureReceipt()`.
2. **Payload:** `CompletedReceiptSchema` plus the optional `isInKind`, a MINOR bump to `RECEIPT_CONTRACT_VERSION` 1.1.0; `X-Schema-Version` negotiation dropped (one process, one `receipt-types`). The producer still asserts against the S1 fixtures.
3. **Identities:** `orgId` is the injected `Org` id (the callee rejects any other); `submitterId` is the uploader's `Person.id`.
4. **Idempotency (`CONCURRENCY.md` §4).** The callee's `@unique` on `receiptId` dedupes; no idempotency key is passed (the key helper was an HTTP leftover and is dropped). A replay, including a concurrent `P2002` loser, returns `created: false` even when the body differs (`submittedAt` is stamped fresh on every push).
5. **Failure semantics:** a throw means not delivered, so this side retries: `pushedAt` stays null and the daily catch-up step or the manual `push-to-inventory` button resends (§4). The source's log-and-drop is not carried. `created: false` counts as pushed. A permanent throw (org mismatch, invalid payload) is a bug; it leaves the receipt visibly unpushed with an audit row per attempt.
6. **The orchestrator owns the fan-out** to expense (S2) and inventory (S3). In the source receipt-app never calls expense or catalog; only `receipt-load-app`'s capital-seed proxy reached expense, and X7 drops it. `SettingsData.workflowMappingUrl` is deleted with the model (§1).

**Inert means queue, never pretend.** Until X6 the inert `ReceiptSink` throws
`not wired`, so finalized receipts wait unpushed and drain in the first daily
catch-up step after the flip. X6 is this lane's PR; gate L7 W and L8 W. The full-pipeline journey flow
test lands with X6.

### X13: in-kind donor → donations

The bulk-donation design (§2.4) owns the callee; agreed signature:
`recordInKindDonor(receiptId: string, donor: InKindDonor): Promise<void>`,
`InKindDonor = { firstName: string; lastName: string; companyName: string | null }`.
`receiptId` is the receipt's UUID string.

- Called when an in-kind receipt is created and again whenever its donor changes.
  Idempotent on `receiptId`: a later call replaces the donor. The donor is never
  null, since upload requires one. Donations joins it with X9's money side on
  `receiptId`, in either arrival order.
- "I am the donor" fills the names from the uploader's `Person` before the call;
  donations needs no separate flag.
- **`withdrawInKind(receiptId: string): Promise<void>`**, sent when the in-kind
  mark is cleared: donations deletes the waiting donor record and any queue entry
  for that receipt. Idempotent; a no-op for a receipt donations never saw. Without
  it donations would keep `pii` for a receipt that became a purchase, with no money
  side to ever surface it. Name confirmed with the bulk-donation design.
- Which call a re-send makes comes from the receipt's current state, not a stored
  operation: in-kind sends `recordInKindDonor` with the current donor, not in-kind
  sends `withdrawInKind`. One marker covers both.
- A throw means not delivered: `donorSyncedAt` stays null, and the daily catch-up
  step or the next edit re-sends. **Inert at S:** throws `not wired`, so nothing is lost
  while donations is not live.
- Donor names leave this lane only through X13; they are never on S1.
- Gate: L6 W and L8 W; X13 is this lane's PR.

### X7: receipt-load → expense, and `receipt-types` becomes permanent

- **Historical bulk import: required** (owner-decided). Years of past receipts,
  each already matched to the QuickBooks entry it was booked as, run through the
  receipt pipeline so the matching tables learn from them and the capital register
  is seeded; nothing is re-booked. This is not a migration of the old app's data.
  - `POST /api/receipts/import` becomes a `FINANCE` route in the receipt library,
    shipped in S/B/W, not held for X7. The schema already carries the QB linkage
    and the `(orgId, importSourceId)` unique, so a re-run skips rows already loaded;
    `CompletedReceipt.backfill` tells expense not to re-post.
  - Batch cap tightens from 1000 receipts to **50 per call**, since each carries its
    file and §2's 10 MB cap applies per file.
  - The **prep tooling ports too**, under `packages/receipt/scripts/` as
    operator-run scripts, not app code: mailbox split, file prep, OCR batch (on the
    library's own OCR call, so the CLI backend goes) and the QuickBooks matcher. The
    Inventory repo is retiring, so they cannot stay there.
  - Imported receipts finalize before X6 and wait unpushed (§4); they train the
    downstream tables when X6 flips. Run the load after X6 to see results at once.
- **Capital seed proxy: dropped.** It forwarded a cookie to expense's
  `POST /api/capital-assets/seed`, which #1272 already hosts as a `FINANCE` route.
- **Promote `packages/receipt-types`** from #1286's temporary copy to the permanent
  contract: drop the removal notes and tracking follow-up, keep `receipt-contract-fixtures`. Gate: X6.

---

## 8. Testing

The source's vitest suites port with the library (Anthropic client mocked). New:
caps; auto-OCR success, failure and refusal; the catch-up steps (counts only);
tax note required; self-approval refused; the reimbursement view against a stub
port; magic-byte rejection of a renamed file and of a `text/plain` upload that is not UTF-8 or holds a NUL byte; OCR output never setting
reimbursee, vendor or `needsReimbursement`; a non-adult uploader's
`needsReimbursement` rejected; a text file rendered as escaped text and served only as an attachment; an image or PDF served inline under `sandbox`; an audit row per file view or download and mail-queue
view; no JSON route returning a `secret` column (jest, in
`src/security/__tests__`). **Forged-From fixtures** for phase G, each of which must
land in the finance queue and never as that person's receipt: SPF pass with no
DMARC alignment; a forged `Authentication-Results: mx.google.com` below Google's
real one; two `From` headers; one `From` with two addresses; a display name
naming a `Person` over a foreign address; a forwarded message whose inner `From`
is a `Person`. One flow test
on the local mock: auto upload → finalized → submitter sees it, "not yet paid"; "Hide completed" hides it. No tier
calls the real API; a dozen-receipt fixture eval is run by hand before any model or
effort change.

---

## 9. Phasing

All PRs are based on `main`; none stacks.

| PR | Contents |
|---|---|
| **S** skeleton | `packages/receipt/`: schema (`ReceiptOrgSettings`; `SettingsData` dropped; new `pushedAt`, `isInKind`, donor names, `donorSyncedAt`; `isInKind` written into `CompletedReceipt.isInKind`; this PR does not edit `receipt-types`), services incl. bulk import and the duplicate-race fix (test first, §2), pre-seated for G: `Receipt.intakeSource`, the `ReceiptMailItem` model and the extended `submitter_review` guard (inert until G), machine, OCR adapter + mock, UI, import prep scripts, `contract.ts` with the `ReceiptSink`, `ReimbursementStatus` and `DonorSink` ports and inert adapters, vitest suites. Port-diff in the body. |
| **B** boundary | `@sensitivity` on the receipt schema (file columns `secret`); after H6; `security/registry/receipt.ts` with every route, including file, import and the mail queue (list, assign, discard); one merge-list line. Maintainers, alone. |
| **W** wiring | route and page stubs, `pageRegistry`, nav (Finance area for queues; "My receipts" where staff can reach it), `configureReceipt()`, harness list entries, `RECEIPT_DATABASE_URL` + `ANTHROPIC_API_KEY` in Infra, flow test. Needs `FINANCE` on `main`. |
| **G** Gmail intake | the mailbox adapter, the step in `reconcile-shopify`, the finance mail-queue page; Infra: the two secrets, the refresher, the consent runbook. After W. |
| **X6** | bind `ReceiptSink` to `ingestReceipt`; pipeline flow test. After L7 W. |
| **X13** | bind `DonorSink` to donations' `recordInKindDonor` and `withdrawInKind`. After L6 W and L8 W. |
| **X7** | promote `receipt-types`, delete temporary shims. After X6. |
| **X12** | expense lane's PR (L3): binds `ReimbursementStatus` to its QuickBooks-backed answer. After L3 W, QB-1/QB-2, L8 W. |

---

## 10. Open questions (stop and ask)

- **Q5. Vendor compliance** (noted by the owner). I believe, but have not
  verified, that Anthropic's API holds the SOC 2 and ISO 27001 attestations the
  Definitions Policy requires. Confirm before W enables the real client in prod.

### Assumptions

- Receipt volume stays in the hundreds a year (drives synchronous OCR and `bytea`).
- A QuickBooks reimbursement can be tied back to its receipt (expense lane to confirm).
- No receipt data is migrated from the source app; the library starts from its seed.

---

## 11. Distillation at merge

Into `docs/rules/finance-payments.md`, if the owner accepts them: a receipt's
financial-review sign-off is recorded with a reason, and a tax exception needs an
explanation; nobody approves or rejects their own receipt; QuickBooks is the
system of record for reimbursement and the app never authors a reimbursement fact;
a duplicate upload is flagged for a person, never rejected, and the file hash is
deliberately not unique (`[Decision — deliberate limit]`); OCR results are never
partially kept. The S1 contract, OCR call shape and secret model go to
`docs/designs/RECEIPT.md`, beside the `EXPENSE_QB.md` reference #1272 §14 plans.
The rest is mechanism and is deleted.

---

*Design for #1265 (FR1), covering #1266 (FR2), #1267 (FR3), #1269 (FR4), #1270
(FR5) and #1271 (FR6); referenced without closing keywords. Lane L8 of the
Inventory parallel port plan; crossings X6, X7 and X13 (callee of X12).*
