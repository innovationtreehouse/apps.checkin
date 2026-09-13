# Critical User Journeys — the full picture (what exists / what doesn't)

> **Provenance:** validation evidence (chip outputs, file:line-cited code checks at base `5528270d`, raw GH dumps) lives in `backlog/sources/` on branch `claude/checkin-backlog-baseline-b0ef5a` — not copied here. Chip ids (V1–V7, A–H) and `sources/...` paths refer to that branch.

Digestible companion to INDEX. Two views (owner wants both):
- **Part A — Persona journeys:** each persona's end-to-end path to success.
- **Part B — Flow-to-success & oversight:** the systemic loops + the **audit / breakage / exception / review screens** that no single persona owns (these are what persona-only designs kept missing).

**State tags** (verified against live code by chips V1–V7):
`✅ EXISTS` · `🟡 PARTIAL` (+gap) · `❌ MISSING` (+INDEX id) · `⛔ OUT` (ruled out of SW) · `🅿️ PARKED-PR` (#nnn, scope source) · `❓ TO-VALIDATE`

Status: **ALL 7 chips folded (V1–V7).** Every step tagged vs live code at base `5528270d`. No ❓ remain in Parts A/B. **Extraction rounds 1–4 (2026-07-22)** added ❌ steps from owner walkthroughs (shirt/add-on offers, trips, FIRST registration, waivers, rollover, alumni, prospect path, calendar feed, sponsorships, statement recon, budget view, metrics, todo board, cert visibility/upgrade) — these are captured wants, NOT code-validated absences (they're net-new by construction).

**Authoritative lifecycle source:** `checkin-app/docs/generated/lifecycle/{membership,enrollment}.md` are auto-generated, drift-checked state machines (from `src/lib/lifecycle/machineSpecs.ts`). They are MORE reliable than any validation chip — where a chip's tag conflicts with these machines, **the machine wins.** Membership PROCESS machine = INTAKE→…→ACTIVE/BLOCKED/ARCHIVED (application/renewal only; does NOT model ongoing grace/inactive — that's the M1 gap). Enrollment machine = UNENROLLED→PENDING_UNPAID→ACTIVE + scholarship-hold + capacity-decrement.

---

## Part A — Persona journeys

### A1. Prospective family → active member (onboarding)  [bucket M/SA]  — validated V1
0a. ❌ Pre-membership: prospect logs in, subscribes to newsletter, gets program notifications; open house on public calendar (`CM14`)
0b. ❌ Preview the membership agreement as view-only PDF without triggering Zoho Sign (`M20`)
1. ✅ Intake application incl "anything else" note (captured + surfaced to reviewers)
2. ✅ Board pre-designation of volunteer household — but drives **dues only**, NOT skip-review→payment (that's a separate `bgFresh` path)
3. ✅ Contract sent + signed (Zoho, embedded)
4. ✅ BG sent + consent (self-attest honor + board backstop; no Averity API)
5. ✅ BG review (2-of-N, anti-collusion gates, board override w/ COI gate)
6. ✅ Reviewer volunteer bit; intake note shown to reviewers (does NOT gate payment — review runs in parallel)
7. ✅ Payment via Shopify (member vs volunteer price + discount code)
8. ✅ Webhook validates payment→activation (HMAC + variant-id check; H2 no-item → stays PENDING + board alert). NOTE: volunteer discount-code entitlement still NOT validated (`CO2`/#278)
9. 🟡 Post-activation fan-out: welcome/congrats ✅ · **mailing-list `CM1` ❌ + badge-print `AT11` ❌ NOT wired to activation**
10. ✅ 18+ student BG trigger on activation (`SA1` Trigger C)
11. ✅ Scholarship/payment-plan request — but **scholarship not modeled distinctly**; rides the board payment-plan-certify override

### A2. Returning family (annual renewal)  [bucket M]  — validated V1
1. 🟡 Renewal cron OPENS the process ✅ but **auto-reminder SEND is gutted** (`renewalReminderSentAt` write-never — `CM5`); manual outreach only
2. ✅ Login yellow "renew by…" banner
3. ✅ Renewal by session userId — no email lookup (anti-enumeration)
4. ✅ BG re-trigger if stale (29mo = board `bgRecheckMonths`, `SA5`)
5. 🟡 Renewal payment reuses Shopify — no in-app Aug-15 date-windowed discount (it's a Shopify coupon)
6. ❌ Nonpayment tolerance → Sept 30: **no grace/lapse/auto-revoke** ("manual admin action" only) → confirms `M1`

### A3. Household lead (ongoing management)  [bucket M]  — validated V1
1. ✅ Add/edit household members
2. ✅ Emergency contacts
3. ✅ Trusted adults (`SA8`)
4. ✅ Address (`M12`)
5. ✅ View membership status
6. 🟡 BLOCKED recovery (`M16` — left-rail alert only, no right-column card)
7. n/a household-merge (doesn't exist; M18 is the **person/record merge** #1103, confirmed)
8. ❌ Archive family (`M4`/#959 parked; `archive.ts` archives *applications* not families; `M19` moot until M4)
9. ❌ Set/maintain each person's t-shirt size (+staleness re-confirm, `P21`)
10. ❌ See own family's tool certs (`SA9`)
11. ❌ Re-read the membership agreement PDF (`M20`)
12. ❌ Policy library — policies/bylaws linked in-app (`CM13`)

### A4. Program leader  [bucket P/GC-ROLES]  — validated V2
1. ✅ Assigned to program — `Program.leadMentorId` FK + `ProgramVolunteer{isCore}` join
2. 🟡 Create program ✅ (`api/programs` POST + `program-ops/new`) — but **ProgramInstance tier ❌** (`P1`/#953 not in base schema; nothing reads an instance)
3. ✅ Set capacity/fee/dates (create form + PATCH; `Program.orgMemberPriceCents`/`nonOrgMemberPriceCents`)
4. ⛔ Assign keyholder per event (manual by design)
5. ✅ Assign 2nd volunteer (`ProgramVolunteer` join) — recruitment/comms itself is AT domain
6. 🟡 Enrollment mgmt — lead can **remove** ✅, **cannot add** (`"Program leads cannot manually add participants"`, by design; only self/household-lead/board/sysadmin)
7. 🟡 Attendance **inbox** ✅ (`my-programs/attendance`, bare `/my-programs` lands here) — full **roster+contact+CSV** read surface ❌ (`P20`, parked PR #964)
8. 🟡 Volunteer hours = residual present-but-not-enrolled, **not** derived from `VolunteerDesignation` (`AT4`); no leader hour surface
9. ❓ Approve expenses (household-COI flag) — finance domain, deferred to V5
10. ❌ Copy program year-to-year (`P9`) — no copy/duplicate route; manual recreate
11. ❌ Archive/un-archive program (`P5`) — no `archivedAt` col, no archive route (#954 not in base; `ProgramPhase` has no ARCHIVED)
_Extraction adds (2026-07-22):_
12. ❌ Shirt-gap dashboard for shirt-issuing programs (`P22`)
13. ❌ Add-on offers w/ deadline — shirts, comp meals (`P23`)
14. ❌ Cross-program org events on multiple calendars (`P24`)
15. ❌ FIRST external-registration tracking incl NH+TX (`P26`)
16. ❌ Trip mode — time-boxed roster/emergency/allergy access (`P27`)
17. ❌ "Requires waiver" enrollment gate (`P28`)
18. ❌ Budget-vs-actual per-program view (`FE8`)
19. ❌ Publish to public Google Calendar w/ cancellation/move display rules (`P14`)
20. ❌ Team year-over-year rollover — auto-carryover + first-dibs window + board reprices (`P25`)

### A5. Volunteer  [bucket AT]  — validated V3
1. 🟡 Designated (`VolunteerDesignation` model exists but **not consulted for hours**)
2. ✅ Assigned to program instance (`ProgramVolunteer` join drives event association)
3. 🟡 Hours derived (`AT4`) — **residual split**: anyone present who is NOT an active `ProgramParticipant` is bucketed "volunteer"; VolunteerDesignation/ProgramVolunteer never consulted for the split
4. ❌ Self-correct own hours (`AT5`) — confirmed MISSING; hours are a derived read, no write/correct route
5. ⛔ Manual hour entry — no hour-entry route; only visit insert (self) / synthetic visit (lead/board)
6. ❌ Org task/todo board — see + claim "what the Treehouse needs done" (one-time + repeating, `PL16`)

### A6. Participant / youth  [bucket P/AT]  — validated V2+V3
1. ✅ Enroll (self / household-lead lookup); public UI
2. 🟡 Youth enrollment rules (`P16`) — age gate **enforced** ✅ (`checkProgramAge`, min/max as-of start, declared-adult/no-DOB handled); youth-specific slot-reserve/parent-notify/limit ❌ (open DECISION, not built)
3. ✅ Check-in / out
4. ✅ Insert own past visit — `attendance/manual` forces `personId=self` (never from body), backdate allowed by design, audit-logged CREATE
5. 🟡 Edit an inserted visit (`AT3` — **now fully mapped**): **user self-edit ⛔ none** (manual route INSERT-only) · **staff edit ✅** board/sysadmin PATCH/DELETE `facility/visits` (⚠️ UI page gates sysadmin-only but API allows board too — role discrepancy) · **lead/ops add-for-others ✅ scoped** (per-session correction via `PATCH events/[id]` `manualEditAttendance`, or live `scan`) — but **no arbitrary-past-time insert for others** exists
6. ❌ Waiver-gated enrollment where the program requires one — camps (`P28`)
7. ❌ Age-out → alumni pipeline (`M21`; SA1 BG trigger already covers the mentor return)

### A7. Keyholder / front-desk (kiosk)  [bucket AT]  — validated V3
1. ✅ Open facility — non-keyholder check-in blocked when `activeKeyholders===0` (scan + manual paths)
2. ✅ Check people in/out — `POST /api/scan` toggles presence, per-participant advisory lock
3. ✅ Presence board — `getFullAttendance` roster+counts+safety (privileged ships DOB/phone/EC, kiosk display-only)
4. ✅ Cert-level display — kiosk cert grid (PII-minimized, #329 pattern)
5. 🟡 Two-deep tracking (`AT6`) — **display flag only, no enforcement** (`isTwoDeepViolation` red banner; no block on last adult leaving, no 60s delay). ⚠️ **`AT10`/#300 fail-open CONFIRMED**: `isYouth(null)→false` so unknown-DOB persons count as **adults** → two-deep silently passes
6. ✅ Keyholder-count warning + forced signout on close — last-keyholder double-badge (≤12s) → `closeAllOpenVisits` SYSTEM sweep marks every open visit departed. (Race `AT9`/#254 not re-tested)
7. ❓ Allergies visibility (`SA7` decision) — not in `getFullAttendance` select; out of traced scope, unresolved

### A8. Tool certifier  [bucket Tools]  — validated V4
1. ✅ Certifier status (`ToolStatus.level = MAY_CERTIFY_OTHERS`; cert reads public-by-design)
2. ✅ Grant/change tool level — ladder ceiling enforced (a tool-certifier may NOT mint `MAY_CERTIFY_OTHERS`; only board/sysadmin can); audit row on every upsert
3. ❌ Certifier ∈ member-family (`M15` HIGH-RISK) — **NOT ENFORCED**: no member-family predicate on actor **or** target `personId` (cert-of-non-member/archived possible); matches #164. Only gate is not-denied + holds-cert
4. ✅ Cert display in shop
5. 🟡 Oversight: no revoke/expiry review surface — downgrade is just a lower-level POST + audit; certs never expire (**deliberate** — Q72)
6. ❌ Cert-upgrade request queue — member proposes upgrade, tool's certifiers tagged to review (`SA10`); member-facing cert visibility is `SA9` (A3-10)

### A9. Board / admin (oversight)  [bucket M/RB/PL]  — validated V7
1. ✅ Review applications + override — board/sysadmin queue (PII field-stripped per role); `review-override` → `overrideBlocked()`
2. 🟡 Manage roles (`RB17`) — `GET/PATCH /api/roles` dual-writes PersonRole + legacy mirror; **UI doesn't scale ~10 roles** (#161/#1150). Not a security hole (PersonRole un-bound, no row-leak)
3. ✅ Board settings (fees/BG months/membership) — gated at layer + stricter per-page. ⚠️ feeds `RB7`: `/api/admin/localization` is sysadmin-ONLY while `/api/admin/broken-households` is sysadmin|board — same prefix, two "admin" defs
4. ✅ Admin edit household (remediation) — `PATCH households/[id]`, audit row per change
5. ✅ Board contact directory — keyholders get `keyholders:pii` (name/email/phone), deliberate owner-confirmed grant; dob/googleId never enter
6. ❌ "Who hasn't paid since Sept 1" dashboard (`M1`) — no arrears dashboard; `OrgMembershipStatus` = NONE/ACTIVE/REVOKED/DENIED, **no GRACE/INACTIVE layer** (#1152); board tracks manually in QB/Shopify
7. ❌ Delete-DOB action (`SA6`) — no purge/redact endpoint (#1165)
8. ✅ Denied/barred enforcement (`GC-BARRED`) — `status=DENIED` dual-enforced (claims strip every flag + middleware `/access-denied`), **re-synced every ≤15min** (not at token expiry), fail-closed on missing account; deny-guard refuses a household containing a board member. Note: **REVOKED does NOT block login** (only DENIED)
9. ❌ Annual org metrics report — family/participant/volunteer counts + hours, the numbers hand-built every year (`PL15`, READY-FOR-DEV)

### Finance / ops — 7 distinct journeys (A10–A16)  [bucket FR/FE/FD/CI + GC-QB]  — mostly PORT from Inventory monorepo; depth per `sources/inventory_capabilities.md`; checkin side validated V5
_Finance is **not one persona journey** — it's 7 Inventory apps, each its own state machine with its own exception/queue screen (those queues are the "missed oversight surfaces"). **The PORT gap is specifically receipts (A10) / catalog (A11) / inventory (A12) / expense→QB (A13) / donations (A14) / hours-alloc (A16)** — 18 of 23 steps ❌ (empty-grep confirmed V5). Every "exception:" line is a distinct screen; each app is separately ownable + shippable._
_**But payment-reconciliation is NOT a gap** — V5 found checkin already ships an undocumented, mature **`finance-ops/`** domain around Shopify payment truth (see A15 + B1): an 11-kind `PaymentException` state machine, daily cursor reconciler, bidirectional match-audit, reversal webhooks, board-alert, and resolution screens. **Zero QuickBooks integration** anywhere (no QB model, field, client, or credential in the schema or `src/`) — so A13/A16's QB post is entirely unbuilt. `@inventory/money` (`formatCents`/`dollarsToCents`) is already a **live shared dependency** between checkin and the Inventory monorepo — the port isn't purely future. Reframe (owner): receipt toil = **inventory cataloging** (thousands of receipts) NOT reimbursement (~10/yr) — high-volume driver is card-receipt intake, so A10-5 upload/line cap is a real throughput+DoS concern._

### A10. Receipt intake  (receipt-app)
1. ❌ Upload receipt jpg/gif/pdf/text + blob store
2. ❌ **Duplicate detection** (file-hash) → `duplicate_flagged` → **human-clear queue** (exception screen)
3. ❌ OCR extract lines/price/qty/supplier/tax/shipping (ocr-function; interim = manual entry) → exception: **retry-OCR**
4. ❌ Financial approve/reject queue + submitter review + reimbursement + discard/resubmit/restart-flow
5. ❌ Carried Inventory-UNFINISHED gaps: no manager-notify on new receipt (#3); **no upload size / line-count cap = DoS surface** (#7)
6. ❌ **Card-statement ↔ receipt reconciliation** — "which transactions still lack a receipt" chase list (`FR8`, NOT in the port; today by hand + QB reconcile)
7. ❌ Submitter-visible reimbursement status ("did I get paid back?") — must survive the port (`FR3` requirement)

### A11. Catalog identify  (global-catalog-app)
1. ❌ Item/GTIN catalog + categories (archive/unarchive lifecycle)
2. ❌ ItemReference vendor-alias 3-pass matcher (many aliases → one GTIN)
3. ❌ Reference proposals submit/approve/reject + supersession dedup
4. ❌ **Reference-conflict resolution queue** (exception screen)
5. ❌ **Provisional part allocation** — sequence + approve/reject/map-to-existing (exception screen; needs global online, UNFINISHED #4)
6. ❌ Conversion challenges (shrinkflation — forward-only unit-factor change)

### A12. Inventory load  (local-inventory-app)
1. ❌ OrgItem + locations (create/reassign)
2. ❌ Receive queue + fulfill; delta-apply in/out per location/owner + inventory log
3. ❌ **Inventory merge-conflict detection + resolution queue** (exception screen)
4. ❌ Provisional-item resolution (consumes catalog org-events)

### A13. Expense → QuickBooks  (expense-app)  [`GC-FIN-CONTROL` + `GC-QB`]
1. ❌ Expense + line model, **owner-approval per line**
2. ❌ Tiered approval per procurement policy (chip H tiers) + tax/COI flags: approve/reject/assign-owner/finance-assign/**raise-exception/resolve-unknown**
3. ❌ QB account mapping (rules → one account/line, no category splits by design)
4. ❌ **Expense holds + resubmit; MULTIPLE_MATCHES hold** (exception screen)
5. ❌ Capital review + depreciation-cycle designation (ordering unvalidated, UNFINISHED #6)
6. ❌ Post via QB event contract (`QbLineItemSchema`, schemaVersion) → **QB sync-failure/ambiguity queue**

### A14. Donations intake  (bulkdonation-app)  [`GC-DONOR`]
1. ❌ Benevity CSV import + parse → Transaction rows (blob retained)
2. ❌ Owner + org-level assignment → **unassigned queue** (exception screen)
3. ❌ Comment-rule engine (auto-classify by comment)
4. ❌ **Disbursement holds + resubmit** (exception screen); GL AccountMap
5. ❌ In-kind / cash / Shopify-donation intake — design surface still open
6. ❌ Donation-receipt send (acknowledgement)
7. ❌ Year-end per-donor giving statement (`FD7`)
8. ❌ **Team sponsorship intake** — company sponsors a specific team, often by check; record + receipt + allocate to that team (`FD6`)

### A15. Income reconcile  — ✅ SUBSTANTIALLY BUILT (checkin-native, not a port) — validated V5
_Exists as membership/program **payment** reconciliation, not generic income/GL._
1. 🟡 Shopify **order** import ✅ (`shopifyRead/client.ts` read-mirror + `finance-ops/s-read/sync` + cron `reconcile-shopify`); **payout import ❌** (`grep payout → 0`) — order-truth yes, payout-truth no
2. ✅ Order matching + **unmatched queue** — `finance/reconcile.ts:530 runReconcile()` (forward+reversal, cursor-driven, idempotent) → `UNMATCHED_ORDER`/`NO_ITEM`/`AMOUNT_MISMATCH` PaymentException; completeness audit `matchAudit.ts` (MATCHED / TRACKED_EXCEPTION / UNCLAIMED_PAID / ACTIVE_WITHOUT_PAYMENT)
3. 🟡 Conflict-resolution **screen exists** (`finance-ops/payments` — OPEN/ACKNOWLEDGED/RESOLVED) — but **QuickBooks reconciliation ❌** (recon is Shopify↔membership only, never touches QB)

### A16. Program-hours finance + orchestration glue  [`GC-PROGRAM-FINANCE` + workflow-mapping-app]
1. ❌ Volunteer/program hours → QB expense allocation (allocation only, not payroll). Concretized (`FE7`): base per-hour shop fee (+surplus for shop-users) → each program's P&L as **monthly QB inter-class journals**; checkin has the hours, needs rates + rules
2. ❌ Orchestrator: received-receipt queue + line-status tracking; line→GTIN associate (optimistic), propose-reference, mark-non-inventory; apply/retry-apply/proceed — _glue; collapses to direct calls in checkin monolith, port only after ≥2 pipeline apps land_

---

## Part B — Flow-to-success & oversight (the cross-persona screens)

_For each loop: does the whole thing close, and can staff SEE/FIX it? These oversight/exception/breakage screens are what persona-happy-paths miss._

### B1. Money loop (purchase → QB)  [FR/FE/CI/QB]  — mostly PORT; per-stage detail in A10–A16
- ❌ Happy pipeline: purchase → receipt intake → OCR → catalog-match → tiered signoff → inventory-load → expense → **QB post** → income-recon → **reconcile vs 3yr QB history** → drift detection
- **The oversight/breakage view is a stack of distinct exception queues** (each a screen, all ❌ PORT unless noted):
  - ❌ receipt **duplicate-flag clear queue** · ❌ **retry-OCR** · ❌ discard/resubmit/restart-flow
  - ❌ catalog **reference-conflict queue** · ❌ **provisional-part allocation queue**
  - ❌ tiered **approval/exception queue** (`GC-FIN-CONTROL`, procurement tiers) + tax/COI flags
  - ❌ inventory **merge-conflict resolution queue**
  - ❌ expense **holds / MULTIPLE_MATCHES / resolve-unknown queue** · ❌ **QB sync-failure/ambiguity queue** · ❌ capital/depreciation review
  - ❌ donations **unassigned queue** · ❌ **disbursement-hold queue** (bulkdonation)
  - ✅ **payment reconciliation is BUILT** (checkin-native, not port): `finance/reconcile.ts` runReconcile → 11-kind `PaymentException` (PAID_WHILE_BLOCKED, NO_ITEM, UNMATCHED_ORDER, AMOUNT_MISMATCH, REFUND, CHARGEBACK, ACTIVE_WITHOUT_PAYMENT, …) → board-alert (`notifyBoardPaymentException`: CRITICAL=immediate email, WARN=red-dot) → **resolution screen** `finance-ops/payments`; reversal webhooks (`webhooks/shopify/reversals`); match-audit completeness (UNCLAIMED_PAID / ACTIVE_WITHOUT_PAYMENT); PENDING_HOLD_FAILED handled at `finance-ops/shopify-holds`. Gap within: **Shopify payout import ❌** (order-truth only)
  - ❌ **rent / recurring non-receipt expense path** (no receipt to OCR) · ❌ audit trail on every step
  - ❌ card-statement↔receipt chase list (`FR8`)
  - ❌ budget-vs-actual per-program view, semi-rolling (`FE8`)
- Reframe (owner): receipt toil = **inventory cataloging** (thousands of receipts) NOT reimbursement (~10/yr) → the high-volume driver is card-receipt intake, so #7 upload/line-count cap is a real throughput+DoS concern, not theoretical.

### B2. Membership lifecycle loop  [M/SA]  — validated V1
- 🟡 application → activation ✅ (closes fully) → **grace → lapse → archive-family = MISSING** (`M1`/`M4`)
- Oversight/breakage: ❌ unpaid dashboard (`M1`) · ✅ **orphaned-payment reconcile queue DOES exist** (V5 corrects V1's understatement): `PaymentException` engine + board-alert + resolution screen `finance-ops/payments` — an actionable queue, not just a log → **narrow item D21 = BUILT** (close it); the broad **`PL1`** aggregate-exception-queue stays open (payment-exception slice now covered, but stuck-processes + failed-sends still live on separate screens) · 🟡 stale-application purge (`M3` — manual archive exists, no auto-purge) · 🟡 BLOCKED contradiction (`M16`)
- **Real oversight surface FOUND (would've missed on happy pass):** `lifecycle-reconcile` cron + `system-status/lifecycle` board page report off-diagram rows — BUT only catch illegal flag combos, **not legitimately-stalled in-flight rows** (5 soft-stick states have no time-based exit). Exception signals are fire-and-forget (log-only). See `sources/cuj_validation_v1_error_paths.md`.

### B3. Program → attendance loop  [P/AT]  — validated V2+V3
- Happy chain: create ✅ → enroll ✅ → capacity-reconcile(Shopify) 🟡 → attend ✅ → infer hours 🟡 → **correct ❌**
- **Enrollment state machine is FULLY BUILT** (surprise upside): all 11 transitions in `enrollmentState.ts` map to live code — scholarship seat-hold (−1 Shopify, released exactly-once), COI-gated approve/deny, PENDING_HOLD_FAILED reconciliation with a dedicated board **screen** (`finance-ops/shopify-holds`), grace-expiry cron. Staff CAN see & fix the hold ledger.
- Oversight/breakage:
  - 🟡 **`T7` non-payment "kick" = machine↔code DRIFT** — the drift-checked machine declares auto-delete→UNENROLLED, but the live cron **only warns household (day 1/3/6) + board digest (day 7+); NO auto-removal** ("removal is a human action"). No persistent overdue-unpaid dashboard → feeds `M1`.
  - ❌ auto-close enrollment at capacity (`P4`) — row lock just *rejects* overflow (400 `requiresOverride`); program stays OPEN, no AUTO_CLOSED state
  - ❌ waitlist (`P3`) — no model, no code
  - 🟡 Shopify capacity reconcile (`P7`) — cap-FIELD edit reconciles as delta; **manual comp-add does NOT bump Shopify max** (exact P7 gap); capped↔uncapped warns-only
  - ❌ attendance ambiguity resolution (`AT2`) — association is deterministic single-match, no resolver
  - ❌ **hour-correction review screen** (`AT12` — the "missed screen") — every correction lands an auditLog row (manual CREATE, visit EDIT/DELETE, events-attendance) but the only review is reading raw audit by hand. Also `AT5` self-correct ❌
  - ❌ Shopify empty-category warnings (`P6`) — `sync-shopify` is checkout-repair, not category reconcile
  - ❌ event-cancel notifies registrants (`CM11`) — cancel `deleteMany` RSVPs + nulls Visit links **silently** (surfaces here, B4 domain)
  - ✅ hygiene: synthetic (SYSTEM) visits excluded from building-hours, so lead "mark present" doesn't inflate measured hours

### B4. Comms / mailing-list loop  [CM]  — validated V6
- ❌ **Entire mailing-list loop absent at all 3 levels** (no write/viewer/review) — but now **IN-DESIGN**: `docs/in-design/MEMBERSHIP_SYNC.md` (PR #1197) covers the engine (`CM1`), coverage-drop detection (`CM2` rescoped — warn-only, no auto re-add), ghost detection (`CM3`), boundary cleanup (`CM4` mostly absorbed; DENIED-newsletter exception net-new). Board decision pending: under-13 on lists (DECISIONS SYNC-1). Was the weakest column; now the best-designed unbuilt one.
- Oversight/breakage:
  - 🟡 **email deliverability/bounce (`CM7`) — surprisingly BUILT**: Svix-verified Resend webhook stamps/clears `Person.emailUndeliverableAt` (self-healing); household broken-email badge; nav red-pill count. Gap: no proactive "fix this address" worklist; no per-message bounce history
  - ✅ **email send-failure queue** — `IntegrationErrorLog` → **Link Status** panel with mark-resolved/reopen (the one mature exception-review surface)
  - ❌ **event-cancel notifies registrants (`CM11`) — silent data loss**: cancel txn `deleteMany` RSVPs + deletes event, **no email** (#472)
  - ❌ staleness auto-notification (`PL14` parked #958) — only a login-time in-app `RenewalBanner`; no nudge cron, no board digest
  - ❌ **renewal-reminder engine (`CM5`) CONFIRMED GUTTED (write-never)** — `cron/membership-renewals` opens PENDING_RENEWAL but sends zero email (test asserts "the machine never emails"); A2.1's ~Jul-15 reminder does NOT send. _(owner: out-of-scope, external fix underway)_
  - ❌ per-program Google Groups auto-managed (3 lists: team/parents/mentors; Slack variant) — group addresses as Program fields (`CM6`)
  - ❌ checkin→public Google Calendar feed w/ **cancellation/move display rules** (`P14`)
  - ❌ policy library (`CM13`)
  - ❌ prospect newsletter/program-notify path (`CM14`)

### B5. Safety / BG loop  [SA]  — validated V4
- Happy chain **FULLY BUILT**: obligation-open (per-person PERSON_BG triggers, idempotent+locked) ✅ → consent (self-attest OR board-record, both paths) ✅ → **2-of-N distinct-reviewer review with anti-collusion** (not-own-household, no double-attest, no shared-household co-reviewer; system never sees the check) ✅ → REJECT→BLOCKED (never activates) ✅ → clearance (2nd APPROVE, per-adult, one check never satisfies another) ✅ → board override w/ COI gate ✅ → renewal re-check (`SA5`, 29mo, enforced at renewal) ✅
- **Warn-only posture (by design):** an un-cleared PERSON_BG obligation NEVER blocks check-in/renewal — surfaced, not gated (SA1 remainder is board-gated enforcement)
- Oversight/breakage:
  - ✅ **compliance dashboard** (board-only): `peopleNeedingBgCheck`, `peopleMissingDob`, household `STALE_BG`/`REVOKED`/`DENIED`/`STUCK_BG_CLEARANCE` — the "can staff SEE it" surface for warn-only
  - 🟡 BLOCKED surface = static red banner + override route; **no proactive escalation/re-notify** beyond one-time reviewer email on entry
  - ❌ **composition sweeps (`SA3`)** — no `NO_CHECKED_ADULT` / "household lost its only checked adult → youth uncovered" flag anywhere. Aged-up youth caught only at NEXT annual run (not at birthday, only if program-attached); SA3-a composition-loss has zero coverage
  - ❌ **BG-alert cascade/escalation (`SA4`)** — no passive-drift escalation, no program-lead alerting, no re-notify
  - ✅/🟡 barred-persons gate (`GC-BARRED`) — modeled as `OrgMembership.status=DENIED` → single denied-login admission gate + BG BLOCKED never activates; caveat: no *per-person* barred registry independent of household status
  - 🟡 two-deep flagging (`AT6`) — detection→board warning email (debounced 5min); **no hard block / 60s delay**. ⚠️ `AT10`/#300 fail-open: unknown-DOB counted as adult (BG verdict path, by contrast, fails SAFE — DOB_MISSING never treated as cleared)

### B6. Audit & oversight (the "review-surface" gap)  [PL/RB]  — validated V6 (thesis CONFIRMED)
- ✅ audit-log **WRITE** (decentralized `auditLog.create` across ~10 routes; actions = CREATE/EDIT/DELETE/BECOME_ADMIN only, **no `reason` field**) → ✅ **VIEWER** (full filter/diff panel, sysadmin-only) → **purpose-built review surfaces mostly ❌**
- The recurring gap (writes exist, review surfaces don't):
  - ❌ PII-**read** audit (`PL2`) — enum has no READ action, no reason column; PII reads entirely un-audited
  - ❌ audit-log clickable links (`PL3`, #1151) — entity/actor rendered as plain text
  - ❌ hour-correction review (`AT12`) — corrections write to AuditLog, no aggregating surface
  - 🟡 aggregate exception queue (`PL1`) — **dispersed, no unified screen**: Link Status (send-failures, resolvable) + Errors (read-only) + nav todo-counts (a *dispatcher* of counts, not one queue); stuck lifecycle processes live in per-domain pages
  - 🟡 system-status/health console — Health/LinkStatus/Lifecycle/Errors/Audit tabs exist; but **top health cards are cosmetic** (Quick Stats `--`, DB/RFID/"Last Backup" hardcoded green literals); config/version/s-read diagnostics ARE live

### B7. Identity / security loop  [RB]  — validated V7
- ✅ sign-in (Google/JWT; int↔string id boundary centralized after 2 prod incidents) → ✅ role/scope resolution (PersonRole→5 flags, SCOPE_BINDINGS per-row resolver, equivalence-tested) → 🟡 per-row visibility (`RB8`) → ✅ denied/barred block (see A9-8)
- 🟡 **`RB8` per-row visibility — field-strip is declarative + solid, but ROW ADMISSION is hand-rolled per route and HAS LEAKED** (#1134): registry only strips *fields*; *which rows* a caller sees is inline handler WHERE. Public-tier rows whose **mere existence is sensitive** (who attends / each enrollment/RSVP/Visit) can't be hidden by field-stripping — "only admission can," and hand-rolled admission has shipped real leaks. Fail-closed row-scope exists only for EmergencyContact
- Oversight/breakage:
  - 🔴 **admin-role ambiguity (`RB7`) — UNRESOLVED, security-sensitive**: 3 incompatible "admin" defs live (sysadmin-only / +board / +operations), no shared `isAdmin` helper, even *within* the `/api/admin/` prefix. A reviewer widening one gate has no canonical definition to check against
  - 🟡 security-gate merge-blocking (`RB16`/#1133) — boundary-isolation job exists; making it a REQUIRED check is branch-protection config (CODEOWNERS on `src/security/**` already active, #1132 closed)
  - ❌ cross-system identity reconciliation (`RB9`) — no Shopify/QB/Google identity-consistency job (`lifecycleReconcile` is state-machine, not cross-system). _(V7 aside "PaymentException model not yet built #1031" is **wrong** — V5 verified the model+engine+screen exist at `schema.prisma:1244`; it's merely not-yet-scope-bound `OPT_OUT_PENDING_ROUTE`, a different thing)_

---

## Validation chips
| chip | domain | tags journeys | state |
|------|--------|---------------|-------|
| V1 | Membership & Household | A1, A2, A3, B2 | ✅ folded |
| V2 | Programs & Enrollment | A4, A6, B3 | ✅ folded |
| V3 | Attendance & Facility | A5, A7, B3(attend) | ✅ folded |
| V4 | Tools & Shop + Safety/BG | A8, B5 | ✅ folded |
| V5 | Finance / Receipt / Inventory / QB | A10–A16, B1 | ✅ folded (18/23 ❌ PORT; A15 recon BUILT) |
| V6 | Comms + Platform/Audit/Oversight | B4, B6 | ✅ folded |
| V7 | Auth / RBAC / Roles / Security | A9(roles), B7 | ✅ folded |

Each chip: verify every ❓ step in its journeys against live code → `✅/🟡/❌` + one-line evidence (file:line). Output a fragment; orchestrator assembles.

**MANDATE (learned the hard way):** chips must validate the **NON-happy-path**, not just "does the feature exist." For each step, also tag the failure / exception / oversight surface — what happens when it goes wrong, and whether staff have a *screen* to see + fix it (vs buried in a log / nonexistent). A happy-path feature existing ≠ its failure/oversight path existing. Part B is entirely this; tag every oversight bullet.
