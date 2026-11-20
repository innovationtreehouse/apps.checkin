# Top-Down Analysis — problem discovery

Companion to INDEX.md. INDEX = bottom-up (what docs/apps/PRs mentioned).
This = top-down: model how the org operates end-to-end, diff vs INDEX, capture the holes.
**Problem discovery only — no design.**

Reference frame: `CONTEXT.md` + `sources/policies_distilled.md` (chip G, 4 policies) + `sources/policies_distilled_2.md` (chip H, 9 policies).
Priority weighting: 1) inventory/bus-factor · 2) toil reduction · 3) QB automation · 4) cost control.
Out of scope: grant conditions, youth-travel safety, governance, insurance.
**No agreed cluster priority yet.** Known signals: budget process = PARKED (not painful); receipt/reimbursement = TOILSOME (hot).

Status: **DRAFT v2 for discussion** (folds in chip H — 9 more policies).

**In-scope clusters (post-probe):**
- **GC-INVENTORY** — parts/consumables full port, receipt-seeded, staged. Mission #1 candidate (Q19/21/22/23) — priority not settled; staying high-level.
- **GC-PROGRAM-FINANCE** — just the hours→QB expense allocation (painful-ish, automatable). Rest parked. **Concretized (Q49 → FE7):** base per-hour shop fee charged to programs (+ surplus for shop-users) hits each program's P&L as real QB inter-class journals; checkin has the hours, needs rates + application rules to initiate.
- **GC-QB** — QuickBooks integration foundation, all net-new, reconcile 3yr history. Underpins expense/allocation/donations. **Settle first.**
- **GC-FIN-CONTROL** — flags low-volume (keep lightweight), but the **expense process is high-volume** (hundreds of card receipts/yr → port the expense-app).
- **GC-DONOR** — multi-channel donation intake (in-kind design surface + Benevity + Shopify multi-SKU + cash) + receipt-sending. In-kind touches inventory.
- **GC-ROLES** — model program-relationship duties (no new roles).
- GC-BARRED = mostly built (verify only, Q20).
Note: the "receipt toil" is **inventory-cataloging** (thousands of receipts replayed), not reimbursement approval (~10/yr).
**Ruled OUT / parked:** GC-SECURITY-OPS (external/AWS infra) · GC-DATA-RIGHTS formal rights+retention engine (manual, never exercised — only stale-membership purge M3 stays) · GC-SAFETY-CONDUCT (conduct, human) · GC-KEYHOLDER (human) · Tripod/per-tool/age shop-state (no control point). **Two-deep IS in scope.** See § Out of software scope.

---

## Headline thesis

INDEX captured **plumbing** — the ported Inventory apps (receipt/expense/QB/catalog/inventory) and
feature gaps in the built app. The policies reveal a **control + governance layer that rides on top of
that plumbing and is almost entirely missing from INDEX**:

- The **Financial Policy** is a full approval/controls regime (budget lifecycle, approval tiers, conflict-of-interest,
  segregation-of-duties, dollar thresholds, functional allocation, capital, card program, bank recon). The ported
  expense/QB apps are generic pipes — they do **not** enforce any of these Treehouse-specific rules. Porting them
  ≠ meeting the policy. **This is where "QB automation is enormous" actually lives.**
- The **Program Leader** is the org's operating hub (owns budget, sets fees/scholarships, assigns keyholders,
  tracks volunteer hours, approves expenses, reports conduct). INDEX has fragments (P1, AT4, My-Programs inbox) but
  the PL is a **program attachment** (leadMentorId) but its **duties/authority** (budget/expense approval, keyholder assignment, conduct reporting) aren't modeled on that relationship.
- A cluster of **live-facility + shop-maintenance** obligations (Tripod, supervision age-gates, Shop Steward,
  tool-breakage) ties directly to Mission #1 (inventory visibility / bus-factor) and is thin in INDEX.

The rest of this file is the three lenses + the consolidated net-new gap clusters + subepic splits + input needs.

---

## Lens 1 — Actor-journey map (orphaned journeys / dead handoffs)

**Program Leader (PL)** — the most under-modeled actor. End-to-end policy journey:
Board authorizes program → PL drafts **Program Budget** → Board approves → PL sets program fee + scholarship budget +
incidentals schedule → PL assigns a **Keyholder per event** + recruits **2nd Adult Volunteer** → runs sessions →
**tracks volunteer hours** → **authorizes/approves expenses** (Treehouse Card or reimbursement) → **reports SoC violations** →
season close → **carry-over / revert** budget. INDEX covers ~2 of ~10 steps (roster/attendance). → **GAP-cluster GC-PL**.

**Financial officer chain** — Treasurer (officer), **Bookkeeper**, **Accountant**. Reimbursement final-approval,
card reconciliation, bank recon (quarterly), capital useful-life/salvage, donor thank-you letters, functional allocation.
RB2 "Finance" is the umbrella role for these; no finance-officer workspace or queue yet. → **GC-ROLES + GC-FIN-CONTROL**.

**Board** — ubiquitous approver: budgets, card issuance, capital retirement, scholarship over cap, non-Member reimbursement,
bank signers. INDEX only models board **membership** review, not a general **board-approval queue**. → **GC-FIN-CONTROL**.

**Shop Steward** — self-organized volunteers who keep tools working; first contact for broken/dull/hazard tools.
Absent from INDEX entirely. Direct tie to Mission #1 (get tool/inventory knowledge out of one person's head). → **GC-SHOP-OPS**.

**Handoff gaps** (one actor finishes, nobody's tooled to pick up):
- expense: purchaser → PL/PT → Treasurer → (+1/+2 Board on COI) — no routing/queue. **(in scope)**
- budget: PL → Board → carry-over — no lifecycle. **(in scope, but parked)**
- _keyholder assignment + tool-hazard-to-Steward handoffs = OUT (human-handled)._

## Lens 2 — Flow-of-value map (everything lands in QuickBooks)

QB is the sink; the **control layer between an event and QB is the gap**, not the pipe to QB.

- **Purchase/expense flow**: purchaser → receipt (60-day) → approval **tier** (in-program? Everyday? amount? card vs reimburse?)
  → COI check → Treasurer → check disbursement → **QB posting** + **functional allocation**. Ported expense-app has the
  skeleton; the **tiered approval + COI + segregation-of-duties + allocation** are Treehouse-specific and unbuilt.
- **Fee/allocation loop** (novel): facility/shop costs are allocated to programs **by hours used across the fiscal year**
  (reduced by the fee the program paid). Hours = **Checkin attendance master**. So Checkin owes QB an allocation feed —
  a cross-system flow nobody has designed. → **GC-PROGRAM-FINANCE**.
- **Donation flow**: online (Shopify, 3rd-party processor only) + corporate (Benevity) + check/cash (Treasurer) →
  **restriction capture (Written Confirmation)** + **IRS thank-you letter** → QB. INDEX FD covers import/entry, not
  restriction-capture or acknowledgment.
- **Reconciliation window ⚠**: **Aug 15** discount ↔ **Sep 1** year-start ↔ **Sep 30** tolerance. Payment date, activation
  date, and membership-year boundary diverge → the recurring Shopify↔activation reconciliation pain (INDEX CO6/P7).
  This is a *timing* gap, not just a feature.
- **Cross-system identity**: Checkin(person) ↔ Shopify(customer) ↔ QB(customer/vendor) ↔ Benevity(donor). Dedup/reconcile
  across all four = INDEX RB9 but scoped only as a concept. → widen RB9.

## Lens 3 — Operating-clock (time-triggered obligations, who owns them?)

| When | Obligation | System owner today |
|------|-----------|--------------------|
| **Jul 1** | Fiscal year start; allocation period opens; capital depreciation runs | none (no budget/allocation system) |
| **Jul 15** | Renewal opens | Checkin (partial) |
| **Aug 15** | Shopify early-pay discount deadline | Shopify + Checkin (recon gap) |
| **Sep 1** | Membership/Program year start: activations, incidentals-fee window opens, new budgets live | Checkin (membership) / none (budgets, fees) |
| **Sep 30** | Nonpayment tolerance ends → lapse | Checkin (partial; enforcement gap M1) |
| **Aug 31** | Membership year end | Checkin |
| **Yearly** | Board sets facility/shop/incidentals fees; area allocation computed over whole fiscal year | none |
| **Quarterly** | Bank reconciliation (accountant written recon) | none |
| **Monthly** | Equipment/intangible depreciation | none |
| **Per-txn** | 60-day reimbursement window; 15-day card-receipt; 60-day card-revocation notice | none |
| **Immediate** | SoC violation report; lost/stolen card | none |

Takeaway: almost every **financial** clock has no system owner (no budget/card/allocation/capital tooling). The membership
clock is the only well-owned one. → concentrates in **GC-FIN-CONTROL**.

---

## Consolidated net-new gap clusters (not in INDEX)

Ordered by mission weighting. Each is a **cluster / candidate epic** — discovery altitude, not issues.

### GC-QB — QuickBooks integration foundation  ·  NEW (Q28)  ·  cross-cutting, Mission #3
- **All net-new** — no reusable QB integration; ported apps map some classes/accounts but with gaps.
- Must **reconcile with 3 years of existing QB financials** (idempotent, sync-not-clobber).
- **Receipts/expenses + donations ≈ 90%** of what lands in QB. Known non-covered gap: **rent** (contractual, auto-paid, not a receipt) — needs its own path.
- **Post-integration research project:** reverse-reconcile against existing QB to enumerate what the system still can't model. Rent is the first known; expect more.
- Underpins GC-FIN-CONTROL (expense→QB), GC-PROGRAM-FINANCE (allocation→QB), GC-DONOR (donations→QB). **Settle the QB connection/auth first.**

### GC-FIN-CONTROL — flags + checkoff + audit  ·  (Q14/Q29)
**Volume reality (corrected, Q29):** the FLAGS are low-volume (~1–2 capital / 1–2 threshold / 1–2 missing-receipt / 1–2 non-Everyday / ~10 reimbursements per YEAR) → keep the flag/checkoff/audit pattern lightweight. BUT the **expense process itself is HIGH volume** — **hundreds of corporate-card receipts/yr** flow through it (signoff → inventory load → QB). That receipt-through-expense flow is the real toil; **port the expense-app** (part of E-PIPELINE), just don't over-build the low-volume flag machinery.
**Reframed by Q14:** the app does NOT enforce approval tiers / COI / segregation-of-duties. It surfaces a **flag** to the right human (finance/board) for a **checkoff**, all **audit-logged**. Humans decide; SW records + routes + proves. Model example: "this line has sales tax + we're a nonprofit → finance checks off it's OK." Board knows when a threshold is crossed and passes that into the SW.
- **Flag/checkoff pattern** (the reusable core): a transaction can raise flags (tax-attached, threshold-crossed, missing-receipt, non-Everyday, **conflict/COI**) → routed to finance/board → checkoff → audit log. Replaces the COI-engine / kinship-model / segregation-enforcer. **The conflict flag is the one with real logic** — a household-aware "approver in submitter's household" check (Q27), buildable because checkin has the household model the ported expense-app lacked.
- Threshold *awareness* (surface $500/$2k/$50 crossings as flags), NOT threshold *enforcement*. Numbers from Procurement (H) inform which flags fire.
- **Functional expense allocation** (hours→QB) — see GC-PROGRAM-FINANCE (kept, painful-ish).
- **Capital asset** flag (≥ threshold → finance checkoff + QB capital handling) — flag, not a depreciation engine.
- **Treehouse Card / bank-recon** — likely QB/bank territory; app's role is at most flag+audit. (Confirm scope if it ever surfaces as pain.)
- ~~COI engine, segregation-of-duties enforcer, budget lifecycle~~ → dropped as enforcement (COI/segregation = flags; budget = parked, INDEX "Consciously not modeled").

### GC-PROGRAM-FINANCE — just the expense allocation  ·  (Q15/Q25)
- **Functional expense allocation** (facility/shop cost → programs by Checkin attendance **hours** across the fiscal year → QB) — the ONE surviving item: IN scope, **painful-ish**, today manual, "really interesting to automate." The novel Checkin→QB flow.
- _Parked/out (Q25): **Scholarship** = fine as-is (Board decides case-by-case, no cap engine); **Incidentals/facility fees** = in Shopify, paid by a few; **Payment plans** = done directly in QuickBooks (no Shopify flow). All → INDEX "Consciously not modeled."_

### GC-ROLES — model relationship duties (not new RBAC rows)  ·  (Mission #2)  ·  (Q27)
**Two live duty gaps:**
- **Expense approval + conflict constraints** — tricky. The ported expense-app can't model the COI/conflict constraints (never had a household model); **checkin HAS household**, so the household-aware "can't approve your own household's expense" check is **buildable here** — a case where the port gets *better* in checkin. Ties GC-FIN-CONTROL's conflict flag. NEEDS-DESIGN (low volume, but the constraint logic is the hard part).
- **Volunteer-hour tracking** — mostly built (AT4); open only: **are the reports enough?** A reports-adequacy review, not a build.

_Below: the underlying relationship-modeling framing._
The "missing roles" are mostly **program-attached relationships** or **derived designations**, most already partly implied in the app. The gap = modeling them + their **duties/risk**, not adding capability roles:
- **Program-attached** (scoped to a program, not global): **Program Leader** (rename RB20 + attach duties/eligibility ≥23+Member+BG+training), **Program Treasurer** (RB1), **Assistant Lead** (RB6). Duties (budget/expense approval, keyholder assign, vol-hours, SoC report) live on the relationship.
- **Derived / designation** (from attributes + assignment): **Youth Mentor** (youth + program-volunteer — already implied), **Key Volunteer** (RB5 — cardholder/complex-procurement risk → Key Volunteer Agreement).
- **Financial actors** under RB2 "Finance" umbrella: Treasurer / Bookkeeper / Accountant (sub-actors, keep RB2).
- **Keep** RB4 "Catalog Manager" + RB6 "Assistant Lead" (basis external). Do NOT drop.
- **Out of the app:** **Shop Steward** is a real org role but system-external (tools only, no app responsibilities) — do NOT model it.
- **Net result: no net-new RBAC roles to add.** The real gap = modeling the program-attached relationships + their duties/risk.

### GC-INVENTORY — parts / consumables / materials  ·  (Mission #1 bus-factor)  ·  (Q19/21/22/23) — candidate, priority not settled
- **Full port** (Q21) — global-catalog + reference-matching + provisional + local-inventory + workflow-mapping (INDEX CI1–CI5). Not an MVP.
- **Seed strategy** (Q22): mainly **receipt-driven** + some manual. **Corpus (Q30): 1,000–2,000 receipts, ALL stored as email** (mixed image / PDF / native HTML), almost all with existing QB records → **replay ALL** to build "what is the catalog" (this is why Inventory is idempotent — replay-safe), then a **live manual count** to true up on-hand. Doubles as a **great OCR test corpus** (fits ocr-function's EML parsing).
- **Linked to receipts, land together-ish, staged** (Q23): receipt→catalog→inventory is ONE pipeline; idempotency lets pieces **deploy independently/incrementally**. This is the E-PIPELINE epic and the answer to "where to go deep" (Q11).
- Scope = what parts/consumables/materials we have (identity, catalog, on-hand, location). Tool-condition = secondary/thin; live supervision = out.

### GC-BARRED — mostly built  ·  (Q20)
- Denied = barred; **probably mostly done** via denied-login (G2) + BG gates. The app already consumes the denied status and gates enrollment/volunteer. Thin **verify** remaining (confirm a dismissed/denied person can't enroll/volunteer anywhere), + the delete-exempt safety-list nuance. Not a real build cluster.

### GC-DATA-RIGHTS — mostly parked  ·  (Q17)
- Formal **Know/Correct/Delete** requests + **retention/disposal engine** + legal-hold → **PARKED** (handled manually; a subject request has **never** been received). See INDEX "Consciously not modeled."
- **IN scope (the one live surface):** **auto-delete of unfinished/stale membership** (INDEX M3) — already brushes this; keep. Its "delete membership-required data → membership terminates (reversible, ≠ Dismissal)" nuance feeds M1.

### GC-DONOR — multi-channel donation intake + receipt  ·  (Q16/Q26)
Donations are **varied**; the real gap is **intake across channels**, all landing in QB:
- **In-kind intake** — net-new **design surface**; **all of ops** can enter one. Architecture (Q31): the **in-kind intake is its own app** that emits **JSON to the others** (catalog reconciliation, inventory load, donation/QB) — same event-driven fan-out as the receipt pipeline. In-kind = donation + goods-received + inventory-add in one intake. NEEDS-DESIGN.
- **Benevity** (corporate import) + **Shopify online** (likely **>1 donation part number/SKU**) + **cash** manual entry — the other intake channels.
- **Donation-receipt sending** — confirmed in scope (extends FD3).
- Still maybe/out: anonymity tiers, restriction capture, Key Volunteer Agreement gating (likely QB/Benevity's lane).

## Out of software scope (recorded so we don't re-surface)
- **GC-SECURITY-OPS** — 2FA/backups/unique-accounts/no-remote-access = handled externally / already in the **infra repo (AWS)** (Q18). Not app work.
- **Data-rights formal requests + retention/disposal engine** — manual; never exercised (Q17). Only the stale-membership auto-purge (M3) stays. → INDEX "Consciously not modeled."
- **GC-SAFETY-CONDUCT** — the entire SoC/conduct incident workflow (report → investigate → discipline → dismissal → anti-retaliation, 24-hr timer, Exec-Committee routing). Handled outside the app. *(App only consumes the end-state via GC-BARRED.)*
- **GC-KEYHOLDER** — PL identifying/assigning Keyholders per event = manual human coordination. *(Keyholder-present warnings + forced-signout are already built; that's the only in-app part.)*
- **Tripod / per-tool-rating / age-based shop-state** — no control point (system doesn't lock shop doors/tools), so tracking has no value. **INDEX AT7 → parked** in "Consciously not modeled".
- **Youth 1:1 comms rules, Close-in-Age, grooming** → OUT (conduct).
- **IN SCOPE — two-deep tracking:** **AT6** two-deep compliance + **AT10** isMinor-fails-open are REAL. Two-deep (2 unrelated non-Student adults) has value even without door control (warn/flag/record). GH **#300** = a genuine bug to FIX, not a vestige to remove.

---

## INDEX items that are really subepics (too broad to be one issue)
- **FE3 "QuickBooks posting"** → actually the whole GC-FIN-CONTROL layer (budget/approval/allocation/capital/card/recon). Split.
- **CI1 global catalog**, **FR3 receipt state machine**, **P1 program-instance** — already XL; explicitly epics.
- **M9 Org-Partner** → policy adds Partner Contact / Partner Participants / Partner Program entitlement tiers. Subepic.
- **RB1–RB6 roles** → each should carry its policy duties/eligibility, not a bare "add role" line.
- **RB9 identity reconciliation** → widen to the 4-system dedup (Checkin/Shopify/QB/Benevity).

## Role-name corrections to apply to INDEX (pending your ok)
- RB2 "Finance" → **KEEP** — umbrella term for Treasurer/Bookkeeper/Accountant (named actors under it, not separate RBAC roles).
- RB5 "Key Volunteer" → **KEEP** — real role (basis outside all 13 policies): *key* = credit-card holder or complex-procurement participant, carrying risk beyond the base membership agreement (triggers Key Volunteer Agreement). Donor-PII "Key Volunteer Agreement" (H flag 7) is one such elevated-risk case, not a separate thing.
- RB4 "Catalog Manager" + RB6 "Assistant Lead" → **KEEP** (absent from all 13 policies; basis external) — get official names from owner.
- **Program Leader** → NOT an RBAC role. It's **program-attached** (a scoped relationship, `leadMentorId→programLeaderId`). RB20 stays a **rename**; its policy duties (budget/expense/keyholder/vol-hours/SoC) attach to that relationship, not a global role.
- **Youth Mentor** → NOT a new role. Already **implied/derived**: youth + assigned as a program volunteer = youth mentor. Model as a derived designation, not a backlog "add role."
- **Shop Steward** → real org role but **external to checkin** (tools only, no app responsibilities) — do NOT model. No net-new roles remain.

**Modeling note (the real GC-ROLES insight):** the "missing roles" are mostly **program-attached relationships** (Program Leader, Program Treasurer RB1, Assistant Lead RB6) or **derived designations** (Youth Mentor, Shop Steward, Key Volunteer RB5), NOT new rows in the global RBAC matrix. The gap is modeling those relationships + their **duties/risk** correctly, not adding capability roles.

## Input still needed
- **Procurement Policy** — RESOLVED (chip H read it): Everyday <$500/≤$250 + full method ladder + $2,000 review tier. GC-FIN-CONTROL tiers now have real numbers.
- **RB4 "Catalog Manager" / RB6 "Assistant Lead" official definitions** — confirmed absent from all 13 policies; owner to supply the external basis/names.
- 13 policies now distilled; **no further policy inputs known to be outstanding** — flag if more get added.
