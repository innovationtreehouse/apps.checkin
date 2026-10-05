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
  account map) under Finance, gated on the `FINANCE` role.
- **Donors' names are personal data.** This is the first ported library whose
  schema carries a `pii` tier; only `FINANCE` reads it, and no broad viewer gate
  exists.
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
| Broad viewer gate (catalog, inventory) | **None.** `FINANCE` only, as in expense (§5). |
| Crossings behind ports (all) | **No library crossing.** One host port, the owner directory, which shares a decision with expense (§6). |
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
  comment, and owner assignment plus comment rules are how it maps to a budget.
  This port treats FD1's "restricted-condition mapping" as that, and builds
  nothing further (open question Q3).
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

## 3. Database and renames

Own database as in #1286 §4. Model names are checked against every source schema
and checkin's: **only `SystemData` collides** (workflow-mapping). The plan's
owner-approved rename is `DonationSystemData`, but its single field
(`localInventoryUrl`) is read by nothing except its own settings page; the owner
lookup it was meant to configure actually calls the auth server. This port
**drops the model, its route, and its page**, which removes the collision rather
than renaming it (Q4; if the owner prefers to keep it, the rename stands).
`Transaction`, `WorkflowEvent`, and `UploadedFile` are generic but unique today;
H1's duplicate-key test guards them.

## 4. Sensitivity: donor data is `pii`

checkin's tiers (`docs/security/SECURITY-POLICY.md`) are applied field by field.
Default is `internal`; nothing is `public` except the synthetic count model.

| Tier | Fields | Why |
|---|---|---|
| `pii` | `Transaction.donorFirstName`, `donorLastName`, `donorComment`; `TransactionCommentRule.comment`; `UploadedFile.fileBlob` | Names identify a person. Comments are free text that often names one ("in memory of…") and are copied verbatim into rules. The blob is the raw CSV, every name included. |
| `internal` | amounts and fees, company and campaign, nonprofit/project/bank ids, dates, `ownerId`, `isOrganizationalLevel`, all actor ids and usernames, `originalFilename`, `fileHash`, counts, `AccountMap.*`, hold `reason`/`matchedRows`/`status`, `DisbursementEvent.payload`, snapshot `state`/`context`, `WorkflowEvent.*` | Financial and attribution data; not identifying alone. |
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
- **Audit payloads never carry donor fields.** The source's `WorkflowEvent.payload`
  holds owner ids, file metadata, and account-map rows only, which is why it can be
  `internal`. W adds a test asserting no donor field reaches a payload; a future
  event that wants one has to change the tier first.
- `DisbursementEvent.payload` and `DisbursementHold.matchedRows` hold Benevity
  transaction ids, accounts, and cents; no names. `internal`.
- **No scopeBindings and no opt-outs.** No field is in `SCOPABLE_FIELDS`
  (`ownerId`, `uploadedByUserId`, `createdByUserId`, `actorUserId` are not), so
  every model is admin-only by construction, as in #1286 §5.

**Who reads donor identity: `FINANCE` only.** Each route's view is
`[finance, ['everyones:pii', 'everyones:internal', 'public']]`; nobody else is
authorized at all. Sysadmin is excluded, matching Finance Ops today
(`finance-payments.md`, Ownership). Whether the board also reads donor names is
Q2. Least-privilege note (`principles.md`): unlike the catalog this narrows
access, and the narrowing applies to `pii` specifically.

## 5. Roles and routes

Every source guard is `isFinance`, except `system-data` (dropped). So every route
authorizes `FINANCE`, the distinct `PersonRoleKind` that expense's L3 role PR
adds. **This port adds no role and no authorize token;** it reuses whatever
finance token L3's boundary PR registers. The comment-rule and account-map
tables are finance curation, the same folding #1272 §6 applies to `isOrgManager`.
`BOARD` has no escalation here: there are no thresholds or conflicts to flag on
inbound gifts.

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
| `owners` | GET |
| `nav-counts` | GET (returns `DonationNavCounts`) |

That is 19 entries. Dropped: `auth/*`, `health`, `system-data`. Volume is
hundreds of gifts a year, so no list gets a `.../count` endpoint now. Pages go
under the Finance section as `NavLink[]` tabs (#1272 §7), gated `FINANCE`.

## 6. Owners and donors: two identity decisions

**Owner directory (a host port, shared with expense).** In the source an owner is
not a person: it is a named budget bucket (`Owner { id, name, orgId, archivedAt }`)
kept by the auth app, and both bulk donation and expense list it through the auth
server. The auth app retires, so checkin has to supply owners. The library
declares `OwnerDirectory { list(): Promise<OwnerInfo[]> }` in `contract.ts` and
stores `ownerId` as an opaque integer; checkin binds it. #1272 §6 models expense's
budget owner as a `Person`, so binding this port the same way keeps one owner
concept across finance. But a donor restriction usually names a program, not a
person, and checkin has `Program`. Which one owners are is Q1, and expense must
answer it identically. Not a pipeline crossing; it is a shared decision.

**Donors (raised, not picked).** Donors could link to checkin `Person`/`Household`
or stay library-local. Recommendation: **library-local.** Benevity donors are
mostly employees of other companies, the file carries first and last name only
(no email), so any link would be a name guess, and a cross-database link adds a
second place donor `pii` is joinable to a household. FD7 (year-end statements) is
the first feature that would want a link, and it can add one deliberately. Q5.

## 7. QuickBooks

The source has **no QuickBooks code.** Its account map produces ledger account
*names*, and completion writes a `DisbursementEvent` that nothing in the Inventory
repo consumes (verified by search). So first landing posts nothing; events
accumulate, as catalog's `OrgEvent` rows do before a consumer exists.

Posting later is a drain of `DisbursementEvent` into QuickBooks, using
`@inventory/quickbooks` and the read-only `AccessTokenSource` from #1272 §9 QB-0,
on the QB-2 write methods. No second connection, no second token, no OAuth route.
It is a deposit (gifts and matches in, fees out), not expense's Purchase/Bill, so
QB-2 needs a deposit write method. That is a dependency on L4's ladder, not a
library crossing, and it is out of this port's three PRs; file it as a follow-up
against FD2.

## 8. Testing

As #1286 §10. The source's unit files port with the library, minus the auth
tests and the auth-server client test. Of its 21 integration files, the five that
call services directly (account-map lookup, processor, money, concurrency,
workflow audit) stay in the package's DB tier on `pg-test-harness`; the 16
route-bound ones become flow tests in W. The A14 journey is upload → auto org-level → assign with comment
rule (bulk applies) → NO_MATCH hold → add rule → resubmit → completed event →
duplicate re-upload is a no-op. A security test asserts a non-`FINANCE` session
gets 403 on every route and that `fileBlob` never appears in a response.

## 9. Phasing: three PRs, each based on `main`

1. **S, skeleton** (`packages/bulk-donation/` + lockfile). Schema with
   `SystemData` dropped, migrations, repositories, services, the machine and
   actor, csv parser, account-map lookup, `contract.ts` (auth, org,
   `OwnerDirectory`), `runtime.ts`, unit tests. Retired auth, `ui-utils`, `utils`,
   `bcrypt`, `jose` removed. Body carries the port-diff against Inventory
   `07797b59`. Needs H3 (`donations`).
2. **B, boundary** (alone). `@sensitivity` on every field per §4,
   `DonationNavCounts` synthetic classification, `security/registry/bulk-donation.ts`
   with all 19 routes, one merge-list line. Needs H1 and L3's `FINANCE` role and
   token on `main`.
3. **W, wiring.** Route and page stubs, `pageRegistry`, Finance tabs,
   `configureBulkDonation()` with the `OwnerDirectory` binding, one line in each
   harness list, flow and security tests, a seed (two disbursements, one clean,
   one that holds; a `FINANCE` persona). Needs H2 and B; the owner binding needs
   Q1 answered.

## 10. Open questions (STOP AND ASK)

- **Q1. What is an owner?** A `Person` (as #1272 assumes for expense), a
  checkin `Program`, or a named budget bucket kept in checkin? Blocks W's binding;
  expense must use the same answer.
- **Q2. Does `BOARD` read donor names?** Default: no, `FINANCE` only.
- **Q3. Is "restricted-condition mapping" more than owner assignment by comment?**
  If restrictions need their own record (restriction text, release date), that is
  net-new and belongs with FD3/FD6, not this port.
- **Q4. Drop `SystemData` instead of renaming it?** Recommended (§3).
- **Q5. Donors library-local?** Recommended (§6).

## 11. Distillation at merge

Rules worth extracting go to `docs/rules/finance-payments.md` (no new file):
donor identity is `pii`, readable by the finance role only; a Benevity gift is
imported at most once per org; a disbursement is booked only when every gift has
an owner or is organizational-level and matches exactly one account rule;
account-map ambiguity is resolved by a person, never guessed. The rest is
mechanism and goes with this doc.

---

*Design for FD1 (#1280), with FD2 (#1281) and FD3 (#1282); lane L6 of the
parallel port plan. Source pinned at Inventory `07797b59`.*
