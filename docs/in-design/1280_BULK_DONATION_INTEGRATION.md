# Bulk donations: porting `bulkdonation-app` into checkin (delta design)

## Problem

Corporate giving platforms pay the organization in batches. Benevity sends one
bank deposit (a disbursement) covering dozens of employee gifts and company
matches, plus a spreadsheet saying who gave what, with what comment, and what
fees came off the top. Finance has to decide which program or budget each gift
belongs to, book every gift, match, and fee to the right ledger account, and
chase any batch whose rows don't map cleanly. Today that runs in a separate
application with its own login, which the organization is retiring. It also
holds the names of individual donors, which none of the inventory tools ported
so far have held.

## Objective

Finance staff import Benevity files, assign each gift to its owner, clear the
account-mapping holds, and read the resulting booking batches inside checkin,
under the Finance area, with donor names visible only to the finance role.

## Executive summary

- **Finance staff** get the four Benevity screens (upload, unassigned queue,
  disbursement holds, booking batches) plus the two rule tables (comment rules,
  account map) under Finance, gated on the `FINANCE` and `BOARD` roles.
- **Donors' names are personal data.** This is the first ported library whose
  schema carries a `pii` tier; only `FINANCE` and `BOARD` read it, and no broad
  viewer gate exists. Donors stay inside the library, unlinked to checkin people.
- **Nothing posts to QuickBooks at first landing.** The source never did either:
  its booking batch is an outbox row with no consumer. Posting arrives later on
  the expense port's QuickBooks client.
- **Not built here:** Shopify, check/cash, and in-kind donation entry, and
  donation-receipt email. The source implements none of them (§2.3).

---

## 1. What this doc changes from the base

The base architecture is settled; this doc restates none of it. Read in order:
the parallel port plan (`INVENTORY_PARALLEL_PORT_PLAN.md`, on branch
`claude/inventory-checkin-parallel-plan-c44a41`), then
`1286_GLOBAL_CATALOG_INTEGRATION.md` §1–§10, `1287_LOCAL_INVENTORY_INTEGRATION.md`
§3–§5, and `1272_EXPENSE_QB_INTEGRATION.md` §5–§6 and §9. Everything below is a
difference from those, or a decision they leave open.

| Base decision | This port |
|---|---|
| Library + own DB + checkin security regime + retired source auth + injected `Org` + vitest/flow tests | Unchanged. Package `@inventory/bulk-donation`, boot call `configureBulkDonation()`, DB `BULKDONATION_DATABASE_URL` (the source's own name, inherited). |
| Field tiers `public`/`internal`, no `pii` (catalog, inventory) | **Donor fields are `pii`** (§4). |
| Broad viewer gate (catalog, inventory) | **None.** `FINANCE` and `BOARD` only (§5). |
| Crossings behind ports (all) | **No crossing for the Benevity surface.** One host port, the owner directory, backed by a checkin-owned owner table that expense also needs (§6). In-kind (FR5) adds four crossings, X9–X11 and X13, declared inert in S (§2.4). |
| Data migration | None. Start from seed (owner decision). |

## 2. Surface

The source is 9 models, 21 human route verbs, 9 pages, an xstate machine with four
states, and about 1,300 lines of page code. Its domain depends on
`@inventory/{money, donations, workflows}`; `money` and `workflows` are already in
`packages/`, and H3 vendors `donations` (a 23-line zod contract). `ui-utils`
(`formatDate`, three pages) is replaced by checkin's own date formatting. `utils`
is used only by the settings page, which this port drops (§7), so it is not
needed.

### 2.1 FD1: Benevity import, dedup, comment rules, owner assignment, GL map

- **Import and dedup.** The upload parses the Benevity CSV (zod-validated; a bad
  number fails the whole file, never coerces to 0), stores the raw file, and
  inserts only rows whose Benevity transaction id is new for the org
  (`@@unique([orgId, transactionId])`). Re-uploading a file is safe; a file that is
  entirely duplicates can have its stored blob deleted. Port verbatim.
- **Owner assignment.** Every gift needs an owner before its disbursement can be
  booked. A gift with no donor comment is auto-marked organizational-level (no
  owner needed). The rest wait in the unassigned queue, where finance assigns an
  owner or marks the gift organizational-level. Both are final once set.
- **Comment rules.** When assigning, finance can tick "apply to future matching
  comments": the comment text becomes a rule, every unassigned gift with the
  identical comment takes the same owner in the same transaction, and later
  uploads carrying that comment match it. Exact string match only.
- **Restricted-condition mapping.** The source has no separate feature by this
  name. A donor's restriction ("for the robotics team") arrives as the donor
  comment, and owner assignment plus comment rules are how it maps to an owner.
  This port treats FD1's "restricted-condition mapping" as exactly that and
  builds nothing further (Q1).
- **GL account map.** Rules keyed on company, campaign (each may be `*`), donation
  method, and donation type yield three ledger account names: donation, match,
  fees. Exactly one rule must match each gift.

### 2.2 FD2: disbursement workflow, holds, resubmit, events

The disbursement machine runs `awaiting_ownership → processing → completed`, or
`processing → on_hold` when any gift matches zero or several account rules. A
hold lists the offending gifts with the rules they matched; finance edits the
account map and resubmits, which re-runs determination. On success the machine
writes one `DisbursementEvent` row: the validated `DisbursementPayloadV1` (one
line per non-zero donation, match, and summed fee, each with its account and
integer cents). `@@unique([orgId, disbursementId])` makes completion idempotent,
and every transition writes a `WorkflowEvent` audit row in the same transaction
as the business change. Port the machine, invariants, actor, and the source's
concurrency test verbatim.

### 2.3 FD3: donation entry, mostly net-new

| FD3 part | In the source? | This port |
|---|---|---|
| Benevity (corporate) intake | Yes (FD1) | Ported |
| Shopify online donations | No. checkin's reconciliation passes donations through untouched (`finance-payments.md`, Reconciliation) | Not built; FD4's income port is the natural home |
| Check / cash entry [board] | No | Net-new, not designed here |
| In-kind entry [ops] | No. TOPDOWN GC-DONOR calls it its own intake that fans out to catalog, inventory, and donations | Net-new, not designed here; it would be a crossing |
| Donation-receipt email | No | Net-new, not designed here |

FD3 stays open after this port. A manual-entry design would reuse this port's
`Transaction` and owner-assignment flow, so the schema should not be bent now to
anticipate it.

### 2.4 FR5: in-kind donation identification (#1270)

FR5 moved to this lane from the receipt design (owner decision). **Nothing in the
source implements it.** A search of the whole Inventory repo for in-kind finds
no code in receipt-app, bulkdonation-app, or anywhere else; the receipt design
reached the same result. So there is nothing to port and nothing to split
between receipt and donations.

What this lane takes on: FR5 as net-new design work, together with FD3's in-kind
entry. **Past in-kind gifts stay in QuickBooks only** (owner decision): there is
no import of historical in-kind donations, so in-kind records start with the
first one entered here. The domain is not built in this port's three PRs; the ports it needs are
declared in S so no later PR waits on another lane. An in-kind donation arrives
one of two ways (owner decision: both are real):

- **With a receipt.** The donor's paperwork goes through the receipt pipeline
  exactly like a purchase receipt: OCR, line extraction, catalog matching (so the
  catalog learns from it), and an automatic inventory load. The difference is
  the money side: no money was spent, so it goes to donations, not expense. The
  uploader marks the receipt as a donation at intake, and the orchestrator routes
  its money side accordingly. **The uploader is often not the donor** (staff
  importing a donor's paperwork), so the in-kind mark asks who the donor is
  instead of assuming the uploader. The uploader must pick "I am the donor" or
  enter the donor's name; a blank donor is not allowed (owner decision). The
  uploader stays recorded as the
  actor; the donor is a separate field. Inventory loading reuses the existing apply
  crossing (plan X4); nothing new there. How the donor reaches donations is X13 below.
- **Without a receipt.** Someone in ops identifies each item by picking it from
  the catalog and enters quantity and value. Donations then loads the goods into
  inventory itself.

New crossings (numbered after the plan's X1–X8), each a port in this library's
`contract.ts` with an inert adapter in S, never a direct import:

| # | Crossing | Kind | Inert adapter |
|---|---|---|---|
| X9 | orchestrator → donations: an in-kind receipt's money side only (`ingestInKind(receipt)`, idempotent on `receiptId`) | sync, in-process, callee | throws, so the caller retries; same as the receipt design's inert S1 sink |
| X10 | donations → catalog: item search and lookup for the no-receipt picker | sync read, caller | empty results |
| X11 | donations → local-inventory: load identified goods (idempotent per source, keyed `donation:<id>`, beside the receipt pipeline's `receipt:<id>`) | sync, in-process, caller | throws |
| X13 | receipt → donations, directly: the donor entered at upload (`recordInKindDonor(receiptId, donor)`, idempotent on `receiptId`; a later call replaces the donor, which is how edits arrive), and `withdrawInKind(receiptId)` when the uploader clears the in-kind mark | sync, in-process, callee | throws |

**Each callee's zod parse asserts `orgId`.** X9 and X13 reject a payload whose
`orgId` is not the injected org; Inventory enforced per-org scoping at the bearer,
and in-process this assertion keeps it.

`donor` is `InKindDonor { firstName: string; lastName: string; companyName:
string | null }` and is never null. The receipt design declares the caller side and has confirmed this signature;
`receiptId` is the receipt's UUID, and "I am the donor" is resolved to the
uploader's name before the call. Clearing the in-kind mark is its own call.

**`withdrawInKind(receiptId: string): Promise<void>`** is idempotent, and a
receipt donations never heard of is a no-op (the receipt side re-sends from
current state, so a withdraw can arrive with no donor ever recorded). It deletes the waiting donor
record for that receipt (donor details are `pii` and would otherwise sit
unmatched forever) and any *donor needed* queue entry. In normal flow no money
side can exist yet: X9 is sent only after the receipt proceeds, and the in-kind
mark is locked from then on. If a money side has arrived anyway, donations does
not delete anything; it raises the receipt in the finance queue as an anomaly.

**The donor never passes through the orchestrator** (owner decision). Donations
joins the two halves on `receiptId`, and either may arrive first:

- **Donor first:** donations stores it and waits; nothing shows in a queue until
  the money side arrives.
- **Money side first** (the donor call has not synced yet): the in-kind donation
  is recorded and shows in the finance queue as *donor needed*. It is not booked
  to QuickBooks until the donor arrives, and the entry clears itself when it
  does. An entry that stays means the receipt side's delivery is stuck.
- **Both present:** the donation is ready to book (§7).

X9 and X13 also change the receipt and orchestrator designs: receipt intake
needs an "in-kind" mark with the donor fields above and calls X13 itself, and
the orchestrator sends that receipt's money side to X9 instead of the expense
crossing (X5). Donor details are `pii` (§4) and are held by donations, which
links them to no checkin person (§6). If the receipt library persists them, it
tiers them `pii` too. How goods are valued for QuickBooks, and what the donor's acknowledgement
says, belong to the in-kind design.

## 3. Database and renames

Own database as in #1286 §4. Model names are checked against every source schema
and checkin's: **only `SystemData` collides** (workflow-mapping). The plan's
owner-approved rename is `DonationSystemData`, but its single field
(`localInventoryUrl`) is read by nothing except its own settings page; the owner
lookup it was meant to configure actually calls the auth server. This port
**drops the model, its route, and its page** (owner-confirmed), which removes the
collision; no rename is needed.
`Transaction`, `WorkflowEvent`, and `UploadedFile` are generic but unique today;
H1's duplicate-key test guards them.

## 4. Sensitivity: donor data is `pii`

checkin's tiers (`docs/security/SECURITY-POLICY.md`) are applied field by field.
Default is `internal`; nothing is `public` except the synthetic count model.

| Tier | Fields | Why |
|---|---|---|
| `pii` | `Transaction.donorFirstName`, `donorLastName`, `donorComment`; `TransactionCommentRule.comment`; `UploadedFile.fileBlob`; `DonationQbCandidateView.memo` | Names identify a person. Comments are free text that often names one ("in memory of…") and are copied verbatim into rules. The blob is the raw CSV, every name included. A hand-entered QuickBooks memo is free text that may name a donor. |
| `internal` | amounts and fees, company and campaign, nonprofit/project/bank ids, dates, `ownerId`, `isOrganizationalLevel`, all actor ids and usernames, `originalFilename`, `fileHash`, counts, `AccountMap.*`, hold `reason`/`matchedRows`/`status`, `DisbursementEvent.payload`, snapshot `state`/`context`, `WorkflowEvent.*`, `DisbursementEvent.qbMatchState`/`qbTxnId`, `DonationQbMatchExclusion.*`, `DonationQbCandidateView` id/type/date/amount (synthetic) | Financial and attribution data; not identifying alone. |
| `public` | `DonationNavCounts { unassignedQueue, disbursementHolds }` (synthetic, §5) | Two scalars; #1286 §7 pattern. |

`companyName` names the donor's employer. With a name beside it, it narrows
identity, but the name is already `pii` behind the same gate, so it stays
`internal`.

**Stripper and registry treatment.**

- No route ever selects `fileBlob`; the list select already omits it, and there is
  no download route. Tiering it `pii` means a future route that leaks it is
  stripped for any view without `everyones:pii`. `secret` would make it
  unreturnable outright, but that tier means cryptographic material, so it is not
  borrowed here.
- **Reads of donor identity are audited.** Every route that returns donor `pii`
  (the transaction lists and detail, the comment rules, the QuickBooks candidate
  view with its memo) and any export of donor data writes an audit row: actor,
  route, record ids or the filter used, row count, time. The row carries no donor
  field. It is a `WorkflowEvent` with `eventType: DONOR_DATA_READ` (route, ids or
  filter, and count in `payload`), so the source's existing audit table holds it
  and no new model or boundary change is needed.
- **Audit payloads never carry donor fields.** The source's `WorkflowEvent.payload`
  holds owner ids, file metadata, and account-map rows only, which is why it can be
  `internal`. W adds a test asserting no donor field reaches a payload; a future
  event that wants one has to change the tier first.
- `DisbursementEvent.payload` and `DisbursementHold.matchedRows` hold Benevity
  transaction ids, accounts, and cents; no names. `internal`.
- **No scopeBindings and no opt-outs.** No field is in `SCOPABLE_FIELDS`
  (`ownerId`, `uploadedByUserId`, `createdByUserId`, `actorUserId` are not), so
  every model is admin-only by construction, as in #1286 §5.

**Who reads donor identity: `FINANCE` and `BOARD`.** Each route's view grants
`['everyones:pii', 'everyones:internal', 'public']` to both; nobody else is
authorized at all. `BOARD` is included because the board acts as the superuser
for finance today (owner decision; Finance Ops is board-only for the same
reason). Sysadmin is excluded, matching Finance Ops (`finance-payments.md`,
Ownership). Least-privilege note (`principles.md`): unlike the catalog this
narrows access, and the narrowing applies to `pii` specifically.

## 5. Roles and routes

Every source guard is `isFinance`, except `system-data` (dropped). So every route
authorizes `FINANCE` (the distinct `PersonRoleKind` that expense's L3 role PR
adds) or `BOARD`, with the same reads and writes for both. **This port adds no
role and no authorize token;** it reuses the finance-or-board token L3's
boundary PR registers, or asks L3 to register one if it ships finance-only. The
comment-rule and account-map tables are finance curation, the same folding
#1272 §6 applies to `isOrgManager`. There is no board escalation path: inbound
gifts raise no thresholds or conflicts.

Routes, all human, all under `/api/donations/`, registered in one B PR:

| Route | Verbs |
|---|---|
| `uploaded-files` | GET, POST (multipart) |
| `uploaded-files/[id]/blob` | DELETE |
| `transactions`, `transactions/unassigned`, `transactions/[id]` | GET |
| `transactions/[id]/owner`, `transactions/[id]/organizational-level` | PATCH |
| `comment-rules` / `[id]` | GET / DELETE |
| `account-map` / `[id]` | GET, POST / PUT, DELETE |
| `disbursement-holds` | GET |
| `disbursement-holds/[disbursementId]/resubmit` | POST |
| `disbursement-events` | GET |
| `nav-counts` | GET (returns `DonationNavCounts`) |
| `disbursement-events/[disbursementId]/qb-candidates` | GET (returns `DonationQbCandidateView[]`) |
| `disbursement-events/[disbursementId]/qb-resolve` | POST (pick a candidate, create, or retry) |
| `qb-exclusions` | GET, POST |

That is 22 entries; the last four serve the drain's finance queue and are registered now so the drain PR touches no boundary. Dropped: `auth/*`, `health`, `system-data`, and the source's `local-owners`: the owner picker reads the bucket list route the expense lane registers with the bucket table (§6), as income does. Volume is
hundreds of gifts a year, so no list gets a `.../count` endpoint now. Pages go
under the Finance section as `NavLink[]` tabs (#1272 §7), gated `FINANCE`/`BOARD`.

## 6. Owners and donors: two identity decisions

**An owner is an accounting bucket** (owner decision). Most buckets correspond to
a program; some, such as Facility, belong to the organization as a whole and have
no program. In the
source the buckets are the auth app's `Owner { id, name, orgId, archivedAt }`,
with approvers attached through its user roles, and both bulk donation and
expense read them from the auth server. The auth app retires, so the buckets
move into checkin:

- **checkin owns the bucket table**, as it owns the `Org` registry: it links to
  checkin's `Program`, and several libraries need it. Minimal shape:
  `BudgetOwner { id, name, programId?, qbClassId, archivedAt? }`. `programId` is
  null for organization-level buckets like Facility.
- **Approvers are derived, never stored** (owner decision). A program bucket's
  approvers are the program's leader and its program treasurers
  (`ProgramVolunteer.isTreasurer`, set by the Board only); an
  organization-level bucket has none. There is no approver table. Approvers
  matter only for money leaving the org (#1272 §6 sign-off seats); this library
  never reads them.
- **This library only lists buckets.** It declares
  `OwnerDirectory { list(): Promise<OwnerInfo[]> }` in `contract.ts`, keeps
  `ownerId` as an opaque integer, uses the list to validate an assignment and
  show bucket names, and never sees approvers. checkin binds the port to its
  table in `configureBulkDonation()`. Exact shape, identical to income's so
  checkin binds both with one implementation over the bucket table (libraries
  cannot import each other, so each declares it):
  `OwnerDirectory { list(): Promise<OwnerInfo[]> }`,
  `OwnerInfo { id: number; name: string; archivedAt: Date | null }`. The source's
  `orgId` field is dropped (the org is injected) and its numeric timestamp
  becomes a `Date`. An archived bucket cannot be newly assigned, and a booking
  that points at one fails until finance remaps it.
- **Expense needs the same table, and #1272 §6 needs a correction**: it models the
  budget owner as a `Person`. Under this decision expense's per-line approval
  check becomes "is this session an approver of the line's bucket", and
  `PartOwnerMap` maps a part to a bucket, not a person.
- **The table is a prerequisite for W here and for expense's routes.** It is a
  checkin schema change with its own sensitivity annotations, registry entries
  for a bucket admin screen, and seed rows, so it ships as its own small PR off
  `main`, before either library's W. **The expense lane (L3) builds it** (owner
  decision), since expense needs the approvers and this port does not.
- **Each bucket is a QuickBooks Class, and the two must stay in sync** (owner
  decision). The bucket table carries the Class id, and creating, renaming, or
  archiving a bucket has a QuickBooks side. Which side is authoritative, and whether sync is pulled
  (QB-1 read) or pushed (QB-2 write), is the expense lane's call on its QB
  ladder; this port only reads buckets.
- **Organizational-level is not an owner.** A gift with no restriction goes to no
  owner at all, as in the source. There are several organization-level buckets
  (Facility is one), so organizational-level never maps to a particular bucket.

This is not a pipeline crossing between libraries; it is host data two libraries
read.

**Consequence for posting.** Because the owner is a QuickBooks Class, a booked
gift has to carry its owner's Class to QuickBooks. The source's
`DisbursementPayloadV1` lines carry account, cents, and Benevity transaction id,
but not the owner. Before the QuickBooks drain (§7) exists, the payload gains
the owner id per line (a `V2`, since the version is in the contract), and an
organizational-level line carries none. Ship V1 at first landing; the bump goes
with the drain, not with this port.

**Donors stay library-local** (owner decision). They do not link to checkin
`Person` or `Household`. Benevity donors are mostly employees of other companies
and the file carries only first and last name, so any link would be a guess, and
a cross-database link would add a second place donor `pii` joins to a household.
FD7 (year-end statements) is the first feature that might want one; it would add
it deliberately.

## 7. QuickBooks

The source has **no QuickBooks code.** Its account map produces ledger account
*names*, and completion writes a `DisbursementEvent` that nothing in the Inventory
repo consumes (verified by search). So first landing posts nothing; events
accumulate, as catalog's `OrgEvent` rows do before a consumer exists. Until the
drain exists, finance keeps booking by hand, and matching reconciles those
bookings when it arrives.

**What gets written.** Both use `@inventory/quickbooks` (L4) and the one
`AccessTokenSource` checkin-app injects into every library. No second connection,
no OAuth route. Every line is tagged with its owner's Class (§6); an
organizational-level line carries none.

Writes go through #1272 §9's one closed-enum, create-only writer: Deposit and
Purchase only here, field-allowlisted, never a Check-type Purchase, with the
retry key written into `DocNumber`/`PrivateNote` and looked up before each create,
and a per-run count and total cap.

**No sign-off seats apply.** The reimbursement and card-charge sign-off seats
(#1272 §6, Financial Policy F2 / F2-COI) govern money leaving the org. Donations
post only inbound Deposits and the in-kind clearing pair, which moves no money
out and is never booked against a card or bank account.

- **Benevity disbursement:** a bank **Deposit** (gifts and matches in, fees out).
- **In-kind donation:** no money reaches a bank, so it books through an
  **"In-kind clearing" account** used in place of a bank account (owner
  decision): a Deposit into clearing (credit in-kind contribution income) and a
  Purchase out of clearing (debit the in-kind expense), same date and amount, so
  clearing nets to zero. Not a bank Deposit and no JournalEntry; both reuse the
  Deposit and Purchase writers. The clearing account is a configured account
  reference whose exact name finance confirms.

**Matching model** (owner decision, shared with income and expense). Matching is
driven from our records, never by scanning QuickBooks.

- **The work list is our own unmatched records.** Each `DisbursementEvent` and
  each in-kind donation carries a match state: `UNMATCHED` →
  `MATCHED(qbTxnId)` or `CREATED(qbTxnId)`, or a finance-queue state
  (`AMBIGUOUS`, `BEFORE_LINE`, `WAITING`, `POST_FAILED`). The queue should fall
  to zero and stay there.
- **Each search is narrow:** for one record, ask QuickBooks only for entries of
  the right type, in the right account (the bank account for Benevity, the
  clearing account for in-kind), with that net amount, dated within 7 days of the
  record's deposit date. The bank reference is not relied on; hand entries
  usually lack it. Old history is never walked.
- **A QuickBooks entry is claimed once.** The claimed `qbTxnId` is stored on the
  record, unique per `(orgId, qbTxnId)`, and claimed ids are dropped from every
  candidate list.
- **Exclusions:** finance can permanently remove a QuickBooks entry from
  candidacy with a reason. `DonationQbMatchExclusion { orgId, qbTxnId, reason,
  by, at }`, unique on `(orgId, qbTxnId)`. The model is prefixed because every
  lane keeps its own exclusion table and classifications merge by model name.
- **One candidate:** `MATCHED`; post nothing (expense's `backfill` path). **More
  than one:** `AMBIGUOUS`; equal amounts are common, so finance picks or creates,
  never a guess. **None, after the takeover line:** create, keyed so a retry never
  books twice. **None, before the line:** `BEFORE_LINE`; a gap among finance's
  own bookings is finance's to explain.

**The takeover line is derived, never configured.** It is the date of the newest
bulk-donation record (Benevity or in-kind) in `MATCHED` state, meaning tied to an
entry the app did not create, whether found by matching or picked by finance.
Each run matches first, then reads the line, then creates for what is after it.
`CREATED` entries never move the line; a late hand booking of a newer record is
matched and moves it forward. With no `MATCHED` record there is no line and the
app creates nothing: it fails closed.

The shared find-or-create in `packages/quickbooks` is stateless: bulk donation
passes the record, its retry key (org + disbursement id, or the in-kind donation
id), its takeover line, and its claimed and excluded ids. It answers *found*,
*ambiguous*, *created*, *failed*, or *before the line*.

**When it runs.** No boot drain and no new schedule (plan rule 5). The drain is
a try/catch step inside the existing prod `/api/cron/reconcile-shopify`, next to
income's; finance's queue actions (pick, create, retry) run it for one record
on demand. The step is idempotent, capped per run, and returns counts only
(matched, created, queued, failed); no ids, donor names or amounts in the cron
response. It ships as a **named follow-up PR in this lane (D, §9)** after L4's
QB-2.

## 8. Testing

As #1286 §10. The source's unit files port with the library, minus the auth
tests and the auth-server client test. Of its 21 integration files, the five that
call services directly (account-map lookup, processor, money, concurrency,
workflow audit) stay in the package's DB tier on `pg-test-harness`; the 16
route-bound ones become flow tests in W. The A14 journey is upload → auto org-level → assign with comment
rule (bulk applies) → NO_MATCH hold → add rule → resubmit → completed event →
duplicate re-upload is a no-op. A security test asserts a session holding neither
`FINANCE` nor `BOARD` gets 403 on every route and that `fileBlob` never appears in a response,
and that every donor-`pii` read writes one audit row with no donor field in it.

## 9. Phasing: three PRs plus the drain, each based on `main`

1. **S, skeleton** (`packages/bulk-donation/` + lockfile). Schema with
   `SystemData` dropped, migrations, repositories, services, the machine and
   actor, csv parser, account-map lookup, the drain's tables pre-seated
   (`DisbursementEvent.qbMatchState` default `UNMATCHED`, `qbTxnId` with
   `@@unique([orgId, qbTxnId])`, and `DonationQbMatchExclusion`) so the drain
   PR adds no schema or boundary change, `contract.ts` (auth, org,
   `OwnerDirectory`, and the inert in-kind ports X9–X11 and X13 from §2.4), `runtime.ts`, unit tests. Retired auth, `ui-utils`, `utils`,
   `bcrypt`, `jose` removed. Body carries the port-diff against Inventory
   `07797b59`. Needs H3 (`donations`).
2. **B, boundary** (alone). `@sensitivity` on every field per §4,
   `DonationNavCounts` and `DonationQbCandidateView` synthetic classifications,
   `security/registry/bulk-donation.ts`
   with all 22 routes, one merge-list line. Needs H1 and L3's `FINANCE` role and
   a finance-or-board token on `main`.
3. **W, wiring.** Route and page stubs, `pageRegistry`, Finance tabs,
   `configureBulkDonation()` with the `OwnerDirectory` binding, one line in each
   harness list, flow and security tests, a seed (two disbursements, one clean,
   one that holds; a `FINANCE` persona). Needs H2, B, and the checkin bucket
   table (§6) on `main`.
4. **D, QuickBooks drain** (named follow-up, after L4's QB-2). The §7 matching
   and Deposit write for disbursements, the finance-queue handlers behind the
   four routes B already registered, the payload bump to `V2` (owner Class per
   line, §6), and one try/catch step in the prod `/api/cron/reconcile-shopify`.
   No schema, registry, or boundary change. In-kind's match fields and its
   clearing-account writes arrive with the in-kind design, which builds that
   record.

## 10. Open questions

None open. Resolved: an in-kind donor may not be left blank; the uploader picks
"I am the donor" or enters a name, so X13 always carries a donor (§2.4).

Handed to the expense lane: build the bucket table,
correct #1272 §6, and decide the bucket ↔ QuickBooks Class sync direction.

## 11. Distillation at merge

Rules worth extracting go to `docs/rules/finance-payments.md` (no new file):
donor identity is `pii`, readable by the finance and board roles only; donors are
not linked to members; every gift's owner is an accounting bucket, not a person; a Benevity gift is
imported at most once per org; a disbursement is booked only when every gift has
an owner or is organizational-level and matches exactly one account rule;
account-map ambiguity is resolved by a person, never guessed. The rest is
mechanism and goes with this doc.

---

*Design for FD1 (#1280), with FD2 (#1281), FD3 (#1282) and FR5 (#1270); lane L6 of the
parallel port plan. Source pinned at Inventory `07797b59`.*
