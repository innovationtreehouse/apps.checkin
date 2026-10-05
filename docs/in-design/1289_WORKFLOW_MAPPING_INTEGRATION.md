# Receipt mapping: porting `workflow-mapping-app` into checkin

## Problem

Every purchase receipt the organization records has to be turned into two
things: an expense the treasurer can book, and stock the shop can count. Between
the receipt and those two outcomes is a step where someone matches each line on
the receipt to a known part ("this line is a box of M3 bolts"), or says it is a
new part, or says it is not inventory at all. Today that matching step runs in a
separate application, on separate infrastructure, behind its own login, that the
organization is retiring. While it stays outside checkin, the receipt pipeline
cannot run end to end in one place, and the people who do the matching need a
second login to do it.

## Objective

Receipt mapping is part of checkin's **Inventory** area: the queue of received
receipts, the per-line matching decisions, and the push of a finished receipt to
expense and inventory all work inside the one application, with the same sign-in.
Its calls to the catalog, to expense, and to inventory, and the receipt hand-off
into it, are ordinary in-process calls behind explicit ports, each of which can be
switched on separately once the library on the other side is live.

## Executive summary

- **Inventory managers** get a receipt-mapping queue, a per-receipt line screen
  (match to a part, propose a new part, mark as not inventory), and an
  apply-failed queue, under the existing Inventory nav. No new role.
- **Finance and the board** can read the same queues and receipts, without
  acting on them.
- **Operators** get nothing new to run. The library adds its own database on the
  shared server; it has no background timer and no settings screen, because the
  peer-server addresses it used to store no longer exist.
- **Developers** get one more isolated library on the base architecture. This doc
  owns the receipt hand-off contract (what the receipt library calls to deliver a
  finished receipt), including its replay-safe dedupe on `receiptId`.
- **What does not change**: the orchestrator's logic. The queue, line statuses,
  optimistic line matching, provisional proposals, and apply / retry-apply /
  proceed are all still built. Only the transport changes, from HTTP between
  servers to function calls in one process.

---

**Issue:** [#1289](https://github.com/innovationtreehouse/checkin/issues/1289),
backlog CI4; it contains CI3 line→part association
([#1288](https://github.com/innovationtreehouse/checkin/issues/1288)) as one
decision (§8d), not a separate app. Journey A16-2 in `docs/backlog/CUJS.md`.

**Base architecture:** `1286_GLOBAL_CATALOG_INTEGRATION.md`, inherited and not
restated; this doc states only the delta. Lane L7 of
`INVENTORY_PARALLEL_PORT_PLAN.md`.

**Source:** `workflow-mapping-app/` in `innovationtreehouse/Inventory` at
`07797b59`. Shared contract: `packages/receipt-types` (S1–S5 zod shapes; the
vendored checkin copy is byte-identical to the source).

**Domain rules relied on:** `docs/rules/principles.md` (least privilege, §6). No
rule in `finance-payments.md` changes; this library books nothing itself.

---

## 1. Shape

`@inventory/workflow-mapping` in `packages/workflow-mapping/`, configured by one
`configureWorkflowMapping()` call, own database (`WORKFLOW_MAPPING_DATABASE_URL`),
one entry in each harness list (H2). Everything else in this doc is a difference
from that base.

The orchestrator is the **middle** of the pipeline, so unlike the three sinks it
is a callee on one side and a caller on four:

```
receipt ──S1──▶ workflow-mapping ──S4──▶ catalog      (lookup, references, proposals)
                                 ──S2──▶ expense      (CompletedReceipt with GTINs)
                                 ──X9──▶ donations    (same, for an in-kind receipt)
                                 ──S3──▶ inventory    (ResolvedInventoryDelta)
          catalog ──S5──▶ workflow-mapping            (provisional resolutions)
```

## 2. What is ported, what is dropped

| Source piece | Disposition |
|---|---|
| `ReceivedReceipt`, `ReceivedReceiptLineStatus`, `WorkflowAuditLog` | ported, names kept (no collision) |
| `SystemData` (3 peer URLs + 3 poll fields) | slimmed to one S5 cursor column, renamed `WorkflowSystemData` (§4) |
| xstate machine, `receiptIntakeService`, `lineItemService`, `apply-receipt`, `auto-proceed`, `audit` | ported verbatim apart from the deltas named in §3, §8, §9 |
| `POST /api/receipts` (S1, org-bearer) | **not hosted**; becomes the exported `ingestReceipt` (§8a) |
| `POST /api/receipts/[id]/all-recognized` | dropped: byte-identical to `proceed` except the 403 message, and no caller |
| `GET /api/catalog-items`, `/categories`, `/subcategories` | dropped: proxies to the old catalog server; the UI reads checkin's own `/api/catalog/*` (an `INVENTORY_MANAGER` passes `catalog-viewer`) |
| `GET/PUT /api/system-data`, settings page | dropped with the peer URLs (§8f) |
| `/api/auth/*`, `/api/health`, login page, `AuthProvider`, `proxy.ts`, `route-auth`, `auth-shared` | dropped: checkin owns auth and health |
| `catalog-client`, `expense-client`, `inventory-client`, `service-client`, `signOrgToken` | replaced by the four outbound ports (§8b–§8e) |

The source has **no S5 consumer**: commit `ee0ba105` removed it as dead code, so
`BYDESIGN.md`'s "runs the org-events poller" is stale. §8e is the consumer
`UNFINISHED.md` #8 asks to reintroduce, not a port.

## 3. State machines and exception queues

**Receipt** (unchanged machine):

| From | Event | To | Fired by |
|---|---|---|---|
| (intake) | any line unrecognized | `pending_review` | S1 ingest |
| (intake) | all lines recognized | `applying`, then push | S1 ingest |
| `pending_review` | `PROCEED` | `applying` | auto-proceed when the last line resolves; or manual proceed |
| `applying` | `PUSH_SUCCEEDED` | `resolved` (final) | push and settle |
| `applying` | `PUSH_FAILED` | `apply_failed` | push and settle |
| `applying`, `apply_failed` | `RETRY` | `applying` | retry-apply |

**Line** (`recognitionStatus`): `unrecognized` → `recognized` (auto-match at
intake, or manual associate) | `provisional` (propose) | `non_inventory` (mark).
A receipt may proceed when no line is `unrecognized`.

**Exception queues** (screens; read by managers, finance and board, acted on by
`INVENTORY_MANAGER`, §6):

1. **Mapping queue**: receipts in `pending_review`, with a count badge.
2. **Apply-failed queue**: receipts in `apply_failed` **and `applying`**. The
   source lists only `apply_failed`, but its UI retries with two calls
   (retry-apply, then apply); if the second never lands, the receipt sits in
   `applying` on no screen. Listing `applying` closes that strand with no
   machine change; the `RETRY`-from-`applying` edge already exists for it.
3. **Audit log**: every transition and line decision, actor-stamped.

**Delta: line edits are refused (409) on `applying` and `resolved` receipts.**
The source lets a line change after its receipt was pushed, rewriting the record
of what was applied with no re-push, against `BYDESIGN.md`'s forward-only model.
Edits stay allowed on `pending_review` and `apply_failed`. Owner decision, for
now; a correction path for pushed receipts is future work (§12).

## 4. Database and renames

Own database, inherited packaging. One rename from the plan's collider table,
owner-approved: `SystemData` → **`WorkflowSystemData`**, `@@map("system_data")`
kept. Every source column on it is dead in checkin (three peer URLs, §8f; three
poll-window fields for a poller that no longer exists, §2), so the ported model
carries **one** column, `orgEventCursor`, the S5 drain cursor (§8e). No data
migration; the library starts from its seed.

## 5. Sensitivity

No `pii`. One `personal` field, never granted to any view.

| Field(s) | Tier | Why |
|---|---|---|
| `ReceivedReceipt.receiptJson` | **`personal`** | the whole `CompletedReceipt`, including `submitterId`, `needsReimbursement`, `reimbursementFor`; the stripper removes it from every response |
| `state`, `recognitionStatus`, `assignedGtin13`, `provisionalItemGtin13`, `conversionFactor`, `conversionVersion`, ids, timestamps | `public` | workflow status and catalog identifiers |
| `orgId`, `receiptId`, `receiptLineItemId`, `receivedReceiptId`, `lineStatusId` | `internal` | cross-app plumbing (catalog's grouping) |
| `validationNotes`, `WorkflowAuditLog.details` | `internal` | free text |
| `actorUserId`, `actorUsername` | `internal` | attribution |
| `WorkflowSystemData.orgEventCursor` | `internal` | never routed |

List, detail, and counts return parsed projections, so B adds three
**synthetic** models (catalog's synthetic-classification mechanism):
`WorkflowReceiptSummary`, `WorkflowReceiptView` (no submitter or reimbursement
fields), `WorkflowReceiptCount`; money fields `internal`. The source's detail
route returns the raw blob; this tiering is what stops that. **Scope bindings:**
none (`actorUserId` is not in `SCOPABLE_FIELDS`).

## 6. Roles

Source auth retires as in the base. Both source manager tiers collapse onto the
existing interim **`INVENTORY_MANAGER`**; no role is added.

| Source guard | Routes | checkin |
|---|---|---|
| `isOrgManager` | proceed, apply, retry-apply | `INVENTORY_MANAGER` |
| `isOrgManager \|\| isGlobalManager` | associate, propose, non-inventory | `INVENTORY_MANAGER` |
| `isOrgManager [\|\| isGlobalManager]` | receipt detail, audit-log | **read gate** (below) |
| `requireUser` | receipt list, counts | **read gate** (narrowed) |
| `requireOrgBearer` | S1 intake | none: in-process export (§8a) |
| `isAdmin` | system-data PUT | dropped |

**Read gate (owner decision): `INVENTORY_MANAGER`, or `FINANCE`, or `BOARD`.**
That is `inventory-manager` ∪ H4's `finance-or-board`; like both, it does not
auto-admit sysadmins. Finance and the board oversee spend, so they read the
queues and receipts; writes stay `INVENTORY_MANAGER`. It is narrower than
catalog and inventory, which widen to `catalog-viewer` because their data is
non-personal; receipts say what was spent, with whom, and who is owed a
reimbursement. The global-manager cross-org bypass is moot: the org check
becomes `row.orgId === org().id`.

**The registry grammar cannot express this gate today.** A route takes exactly
one `Authorize`: a single string token, or `{ anyRole: BusinessRole[] }`. There
is no OR of two tokens, and `BusinessRole` (`types/auth.ts`) holds neither
`isInventoryManager` nor `isFinance` (H4 adds `isFinance` to `Role` only).
**Fix, no new token, owned by H4:** H4 widens `anyRole`'s element type from
`BusinessRole` to the session-flag members of `Role`, resolved through
`callerHoldsRole`, in the same boundary PR as the rest of the finance
vocabulary. The read routes then declare
`{ anyRole: ['isInventoryManager', 'isFinance', 'isBoardMember'] }`, which is
exactly the union above (`anyRole` has no admin auto-admit); existing `anyRole`
routes are unaffected because `BusinessRole` stays a subset. The read view (`orderedView`) grants the
same `public` + `internal` tiers to all three roles.

## 7. Surfaces

All registered in B up front (10 routes), under `/api/workflow-mapping/`:
`GET receipts` (`?state=`), `GET receipts/counts`, `GET receipts/[id]`,
`POST receipts/[id]/{proceed,apply,retry-apply}`,
`POST receipts/[id]/lines/[lineStatusId]/{associate,propose,non-inventory}`,
`GET audit-log`. Pages are the source's queue, receipt, line, apply-failed,
catalog-review, and audit-log screens, reskinned, as section tabs in the
Inventory area.

## 8. Crossings

The base rule holds for every crossing: keep the zod contract, change only the
transport, put the call behind a port in `contract.ts`, bind it once in
`configureWorkflowMapping()`, and flip a crossing by swapping that one binding.
No crossing is HTTP in checkin; the `http` adapters are not ported.

**Inert means "queue, never pretend".** An inert S2/S3 adapter throws
`not wired`, so a pushed receipt waits in `apply_failed` for the flip. A no-op
returning success would mark receipts `resolved` with nothing booked or counted.

### 8a. S1 inbound: receipt → orchestrator (this doc owns it)

The orchestrator is the **callee**, so it defines the contract the way #1287
§8c defined the apply surface. The receipt library binds its own port to this
export in its `configureReceipt()` (crossing X6, receipt lane).

```ts
// exported by @inventory/workflow-mapping
ingestReceipt(
  receipt: CompletedReceipt,               // CompletedReceiptSchema + isInKind
): Promise<{ id: number; state: ReceivedReceiptState; created: boolean }>
```

**Payload.** `CompletedReceipt` as `receipt-types` defines it today, plus one
additive field, `isInKind: z.boolean().optional().default(false)`, which the
receipt lane sets at upload for a donor's paperwork (the name agreed with the
receipt design, FR5). Additive, so `RECEIPT_CONTRACT_VERSION` takes one MINOR
bump, to `1.1.0` (§11). A receipt that omits the field is a purchase.
`CompletedReceipt` gets **no donor field**: the in-kind donor travels receipt →
donations directly (crossing X13, owner decision), so the orchestrator neither
stores nor forwards donor data.

**Idempotency: `receiptId` is the key.** No separate key parameter: the
`Idempotency-Key` header was an HTTP transport detail, and an in-process call has
no header to carry. The existing `@unique` on `ReceivedReceipt.receiptId`
enforces the dedupe:

- First delivery wins. A replay returns the stored `{ id, state }` with
  `created: false` and changes nothing, **even if the body differs** (the
  receipt side stamps `submittedAt` fresh on every push, so bodies never match
  byte for byte).
- Two concurrent first deliveries: the loser's `create` hits `P2002`, which
  `ingestReceipt` catches and answers as a replay. This is the CONCURRENCY.md
  §4 fix; today the loser gets a 500.

**Org.** The source took the org from the bearer token and ignored
`receipt.orgId`. In-process there is no token: `ingestReceipt` rejects
`receipt.orgId !== org().id` and takes `orgName` from the injected accessor.

**What ingest does, synchronously, inside the caller's call:** validate, dedupe,
run S4 recognition (a failed lookup is non-fatal: every line stays
`unrecognized`), write the receipt and its line statuses, audit
`receipt_created`, and, if every line was recognized, transition to `applying`
and push S2/S3.

**What a throw means.** Only an invalid payload, an org mismatch, or a
database failure throws. A **push** failure is not an ingest failure: the receipt
is recorded and returned as `apply_failed`. So a throw always means "not
delivered", and the caller must retry, not log and drop as the source's
`finalizeReceipt` does.

**Dropped:** the `X-Schema-Version` negotiation. Both sides compile against the
same `receipt-types`, so a major-version mismatch cannot occur in one process.

### 8b. S2 outbound: orchestrator → expense

Port `ExpenseSink.pushReceipt(receipt: CompletedReceipt)`; expense dedupes on
`receiptId`, with no separate key (same reasoning as §8a). The receipt carries each resolved
line's GTIN (and `isProvisional` / `provisionalName`), stitched by
`buildExpenseReceipt` as in the source.

- **Inert at S:** throws `not wired`.
- **Flip (X5):** L3 W is live, and expense exports its intake with the
  `ReceivedExpensePayload` "already applied → no-op" check **inside the
  service**. In the source that check is in the HTTP route; an in-process call
  that bypassed it would book a retried receipt twice.

### 8b′. X9 outbound: orchestrator → donations (in-kind money side)

An in-kind receipt (`isInKind: true`) runs the whole pipeline unchanged:
recognition, line matching, and inventory load through S3. Only its money side
differs; no money was spent, so push-and-settle sends the receipt to donations
**instead of** expense, never to both. Port
`DonationSink.ingestInKind(receipt: CompletedReceipt)`, the bulk-donation
design's X9 signature, idempotent on `receiptId` at the callee; the payload is
the same GTIN-stitched receipt S2 sends. X9 is **money-only**: no donor data
crosses it (the donor goes receipt → donations on X13, §8a).

- **Same failure semantics as S2.** The money leg runs in parallel with S3; if
  either throws the receipt goes to `apply_failed`, and retry-apply re-pushes
  both, relying on each callee's `receiptId` idempotency.
- **Inert at S:** throws `not wired`, so an in-kind receipt waits in
  `apply_failed` until X9 flips, while purchase receipts are unaffected.
- **Flip (X9):** L6 W is live, with `ingestInKind` idempotent on `receiptId`.

### 8c. S3 outbound: orchestrator → local-inventory apply

Port `InventorySink.applyDelta(delta: ResolvedInventoryDelta)`, with no separate
key (same reasoning as §8a), bound to the apply export #1287 §8c defines. The orchestrator uses **only the apply row** of #1287 §8c's table;
the create-provisional, enqueue-receive, org-item read, and service-variant rows
have no caller anywhere in the source.

- **Sole caller from the receipt pipeline (owner decision).** For receipts,
  the orchestrator is the only caller of local-inventory apply, at proceed time,
  as in the source. Inventory load does **not** wait on expense sign-off, and
  #1817 §8c's expense → inventory "I" crossing is **dropped**. Donations also
  applies, for in-kind goods that arrive without a receipt (X11); that is a
  separate source, not a second receipt caller.
- **Inert at S:** throws `not wired`.
- **Flip (X4):** L2 W is live, **and the apply export is idempotent per
  source**. It is not, today. #1287 §8c says a re-push is a safe retry, but
  the source route upserts the delta ledger row and then always calls
  `applyReceipt`, which adds every quantity again, and no receiver reads the
  `Idempotency-Key` header. Retry-apply after a partial failure (inventory
  succeeded, expense failed) would therefore double-count stock. The fix is in
  the callee: a guard keyed per source (`receipt:<id>` here, `donation:<id>`
  for X11) that short-circuits when that source's `ReceivedInventoryDelta` row is
  already `applied`, as expense does. **Owned by the local-inventory lane** (owner
  decision): its own PR after #1859, test first, which also corrects #1287
  §8c's "safe retry" sentence. X4 does not flip until it lands.

### 8d. S4 outbound: orchestrator → catalog (CI3 association lives here)

Two ports, both bound to `@inventory/global-catalog` services:

| Port | Method | Catalog service | Used by |
|---|---|---|---|
| `CatalogReader` | `lookupItems(retailer, lookups)` | `referenceMatchingService.lookupMany` | intake recognition |
| | `checkReferences(fields)` | `referenceMatchingService.checkReferences` | associate |
| `CatalogSubmissions` | `proposeItemReference(p)` | `proposalService.createItemReferenceProposal` | associate |
| | `reportConflict(p)` | `conflictResolutionService.reportConflict` | associate |
| | `allocateProvisionalGtin()` | `provisionalGtinService.allocateNextProvisionalGtin` | propose |
| | `proposeProvisionalItem(p)` | `provisionalGtinService.createProvisionalItem` | propose |

Param and return types are the `receipt-types` catalog schemas, as in the source.
The adapter stamps the injected org and the acting `Person.id`.

**CI3, line→part association, is decided here as the source decides it:
optimistic.** Associate marks the line `recognized` with the manager's GTIN and
factor at once, then submits a reference proposal when the identity tuple is new
and a conflict report for each existing reference that disagrees. Neither gates
the receipt, and a later catalog verdict never rewrites an applied receipt
(`BYDESIGN.md`, optimistic line resolution). Port it as is.

- **Inert at S:** `lookupItems` returns no matches (every line `unrecognized`,
  never a guess); `checkReferences` and the four submissions throw `not wired`,
  so associate and propose fail loudly rather than skip catalog curation.
- **Flip (X3):** L7 W. The catalog is already live, so this is the first flip and
  the others are useless before it.

### 8e. S5 consumer: catalog → orchestrator (push-driven, no timer)

Reintroduces `UNFINISHED.md` #8 on #1287 §8a's mechanism: port
`CatalogEventSource { drainPending(orgId), subscribe(onEmit) }`: drain-on-emit
from catalog's post-commit hook, inside the user request that committed the
event, with bounded per-row retry. **No DB access at app boot and no new
schedule** (plan rule 5): the catch-up sweep (cursor replay after a crash or a
failed drain) is a try/catch step inside the existing prod
`/api/cron/reconcile-shopify`, next to the other libraries' sweeps. No
`setInterval`. No local event ledger: every action below is a set-to-value
update, so replaying from the cursor (`WorkflowSystemData.orgEventCursor`) is
safe.

| Event | Action |
|---|---|
| `provisional_approved`, `provisional_mapped_to_existing` (X → Y) | lines with `provisionalItemGtin13 = X` on receipts **not `resolved`** → `recognized`, `assignedGtin13 = Y`, factor and version from the event |
| `provisional_rejected` | audit only (owner decision; the machine has no way back to `pending_review`) |
| everything else | `default: break`, kept (verdicts and conversion challenges are not the orchestrator's, per `BYDESIGN.md`) |

Resolved receipts are left alone: their line status records what was pushed,
and downstream converges on its own consumers. On `apply_failed`, the retry
pushes Y.

- **Inert at S:** the port is bound, nothing subscribes.
- **Flip (X2):** X1 (catalog's post-commit signal) plus L7 W; the same PR adds
  the cron step.

### 8f. Peer URLs go away

The source stored `expenseAppUrl`, `localInventoryUrl`, and `globalServerUrl` in
its `system_data` row, edited them on a settings page, cached them per client,
and invalidated the caches on save. All of it is deleted: the columns, the
`system-data` route, the settings page, the three URL caches, `resolveUrl`, and
the `service-client` dependency. A port binding replaces each URL. (The receipt
side has the mirror image, `SettingsData.workflowMappingUrl`, which the receipt
design deletes the same way.)

## 9. Concurrency

| Hazard | Disposition |
|---|---|
| CONCURRENCY.md §4, concurrent S1 double-push | fixed in S (§8a, `P2002` → replay), with a concurrent test |
| CONCURRENCY.md §1, two managers resolve the last two lines at once, both auto-proceed | fixed in S, test first: the `PROCEED` write becomes compare-and-set (`updateMany where { id, state: 'pending_review' }`), and only the caller that gets `count === 1` pushes. Downstream idempotency (§8b, §8c) is the second line of defence, not the fix |
| retry re-push double-counting stock | callee fix in L2 (per-source guard), gates X4 (§8c) |

Both S fixes show in the S port-diff as the only non-mechanical hunks, each with
its failing-first test.

## 10. Testing

The source's 22 Vitest files port onto `@inventory/pg-test-harness`; the S1 and
S2/S3 contract tests become port-level (fixtures into `ingestReceipt`; a
recording sink asserts the payload). New: S1 org rejection and replay, both
concurrency fixes, the line-edit 409, the S5 remap, inert adapters → `apply_failed`.

Flow tests are HTTP-only and S1 has no route, so W adds a **dev-only seed
macro** (absent when `CHECKIN_ENV=prod`, per `docs/ops/dev-instance.md`) that
calls `ingestReceipt` with a fixture. The full pipeline journey flow test lands
with X6.

## 11. Phasing

Three PRs, each based on `main`, per the parallel plan.

| PR | Contents |
|---|---|
| **S** (skeleton) | `packages/workflow-mapping/`: verbatim port; schema with `WorkflowSystemData` slimmed and renamed; `contract.ts` with `WorkflowRuntimeConfig` (principal, org accessor, `httpError`) and the six ports `CatalogReader`, `CatalogSubmissions`, `ExpenseSink`, `DonationSink`, `InventorySink`, `CatalogEventSource`, each with an inert adapter; push-and-settle routing the money side on `isInKind`; `ingestReceipt` with org and `P2002` handling; the `PROCEED` compare-and-set; line-edit 409; `applying` in the failed queue; the drops in §2. Plus the only `packages/receipt-types` change any lane's S makes, called out in the PR body: the `CompletedReceipt.isInKind` field; deletion of the four HTTP-transport exports that no longer have a caller (`expenseApplyIdempotencyKey`, `inventoryApplyIdempotencyKey`, `IDEMPOTENCY_KEY_HEADER`, `SCHEMA_VERSION_HEADER`) and their tests, after a fresh grep of `packages/` and `checkin-app/` confirms no caller; and one MINOR bump of `RECEIPT_CONTRACT_VERSION` to `1.1.0`, per `contract.ts`'s own rule (the version covers the payload schema, not helper exports). The receipt lane's S only consumes the field, so no two S PRs edit the version line. |
| **B** (boundary) | `@sensitivity` on the package schema (§5); `security/registry/workflow-mapping.ts` with all 10 routes and the 3 synthetic models (writes `inventory-manager`; reads `{ anyRole: ['isInventoryManager', 'isFinance', 'isBoardMember'] }`); one merge-list line. Inert. Depends on **H4** (local branch `claude/charming-bardeen-a13163`, opens after #1856), which adds `isFinance` and the `anyRole` widening (§6). |
| **W** (wiring) | route and page stubs, `pageRegistry`, Inventory section tabs and badge, `configureWorkflowMapping()` binding the inert adapters, harness list lines, the dev seed macro, flow tests. |

**Wave-3 crossing PRs owned by this lane**, each one binding swap:

| # | Flip | Gate |
|---|---|---|
| X3 | S4: bind both catalog ports in-process | L7 W |
| X2 | S5: subscribe, plus the catch-up step in `/api/cron/reconcile-shopify` | X1 + L7 W |
| X5 | S2: bind `ExpenseSink` | L3 W + expense intake idempotent in its service |
| X4 | S3: bind `InventorySink` | L2 W + the per-source apply guard (`receipt:<id>` / `donation:<id>`) |
| X9 | in-kind money side: bind `DonationSink` | L6 W (`ingestInKind` idempotent on `receiptId`) |

X6 (S1) is **the receipt lane's** PR: this lane delivers the callee in S, and the
receipt library binds to it. Until X4 and X5 (X9 for in-kind) flip, receipts that reach push wait
in `apply_failed`, which is the intended holding behaviour.

## 12. Open items

- **Follow-up, not designed here:** a deliberate correction path for
  already-pushed receipts, adjusting inventory and expense too.
- **Corrections owed elsewhere:** #1817 §8a's "receipt-app → expense" should read
  "workflow-mapping → expense" (§8b); #1817 §8c's "I" crossing is dropped (§8c);
  #1287 §8c's "safe retry" sentence (the local-inventory lane's fix).
- **At merge:** `CUJS.md` A16-2 says the orchestrator "collapses to direct calls
  in checkin monolith". Only the transport changes; update the line.

Resolved by the owner: the orchestrator is the sole S3 caller (§8c);
the local-inventory lane owns apply idempotency (§8c); `provisional_rejected` is
audit-only, since the machine has no way back to `pending_review` (§8e); reads
include finance and board (§6); line edits on `applying` and `resolved` receipts
return 409, for now (§3).

## 13. Distillation at merge

Deleted at merge. Rules for `docs/rules/inventory.md` (reserved by #1287 §13),
each passing the "could a change violate it?" test:

- Receipt-mapping writes are `INVENTORY_MANAGER`-only; reads are
  `INVENTORY_MANAGER`, `FINANCE`, or `BOARD`, never the broad inventory viewer
  gate, because receipts carry spend and reimbursement data.
  — *Principle: least privilege*
- Within the receipt pipeline, only the receipt-mapping step loads a receipt
  into inventory, when the receipt proceeds; expense sign-off does not gate or
  repeat the load. Inventory applies at most once per source.
- A receipt is delivered to mapping at most once per `receiptId`; a replay is a
  no-op that returns the stored state.
- A line is matched on the manager's decision immediately; a later catalog
  verdict never rewrites an applied receipt. `[Decision — deliberate limit]`
- An in-kind receipt's money side goes to donations, never to expense; its goods
  load into inventory like any other receipt.
- No push reports success while its target is not wired; an unwired target
  holds the receipt in the apply-failed queue.

The port model, the S1 contract, and the flip gates go to
`docs/designs/WORKFLOW_MAPPING.md` alongside the catalog and inventory
references. The rest is mechanism and is deleted.
