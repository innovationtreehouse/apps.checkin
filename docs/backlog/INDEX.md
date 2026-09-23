# Backlog Index (buckets)

> **Provenance:** validation evidence (chip outputs, file:line-cited code checks at base `5528270d`, raw GH dumps) lives in `backlog/sources/` on branch `claude/checkin-backlog-baseline-b0ef5a` — not copied here. Chip ids (V1–V7, A–H) and `sources/...` paths refer to that branch.

Status: **APPROVED baseline (v2, 2026-07-20).** Synthesized from all sources (chips A–F + D2),
deduped, bucketed, tagged. Buckets + coverage + readiness + GH associations signed off (Q5).
GH issues opened for every backlog item (2026-07-22): #1226–#1322 for the net-new set, plus pre-existing handles. Only `CM5` (external fix underway), `RB18` (anti-item, "do NOT port"), and `RB22` (open rename DECISION — may not be wanted) intentionally have no issue.

## Legend
- **Origin**: PORT (exists in an Inventory app) · CREATE (net-new) · ENHANCE (extend built checkin) · FIX (open bug) · DECISION (keep/kill or policy call)
- **Readiness** (design→dev pipeline state ONLY):
  - `NEEDS-DESIGN` · `IN-DESIGN` (doc exists, don't-start) · `READY-FOR-DEV` · `VERIFY` (needs code check) · `DECISION` (product/policy answer needed) · `COND` (genuinely gated on an external trigger — see note)
  - **NOTE:** "deferred from v1 launch" is NOT a readiness. Items cut from v1 scope are still wanted; their readiness reflects design/dev state, not the old launch call. Only `COND` marks a real trigger-gate (e.g. "adopt once unattended").
- **Src**: chip letter(s). **GH**: existing issue handle (open/closed) or `none`.
- **Size**: S/M/L/XL(epic). IDs are bucket-prefixed and stable for later reference.
- **Workaround**: the current manual workaround if the feature is missing (affects urgency). `?` = not yet assessed · `none` = no workaround, higher pain.

**When an item is confirmed done/built: DELETE its row** from the bucket table and add a one-liner to § Dropped — no struck-through or verbose "BUILT-DROP" rows (keeps the buckets clean).

Legend of drops: see [§ Dropped — confirmed built](#dropped--confirmed-built-not-backlog) and each source file in `sources/`.

---

## 1. Membership & Household  (prefix M)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| M1 | **Ongoing-membership status machine**: add GRACE + INACTIVE + scheduled active→grace→inactive (OrgMembership.status is NONE/ACTIVE/REVOKED/DENIED only). NOTE: distinct from the built `OrgMembershipProcess` *application/renewal* lifecycle (generated/lifecycle/membership.md, ends at ACTIVE/ARCHIVED) — this is the missing *ongoing* layer on top. Cross-link (PR #1197): the membership-sync's "lapse" removal = **manual revoke only until M1 lands** — 1197 states the dependency explicitly. | ENHANCE | NEEDS-DESIGN | L | board tracks manually (QB/Shopify) | B,E,generated | #1152 (open, viz) |
| M2 | Membership **state-maintenance cron** (compliance eval + warn-only violations dashboard; never auto-terminate) | CREATE | NEEDS-DESIGN | M | manual board review | B | #1226 (open) |
| M3 | Stale-application lifecycle (60d archive / 180d purge-if-never-active) | CREATE | NEEDS-DESIGN | M | ? | B | #1227 (open) |
| M4 | **Archive Family** — #959 **proposed** a thin first cut (single `archivedAt` stamp + shared active-filter + write-guards + board toggle) but was **closed unmerged (2026-08-05) — nothing shipped**; `Household.archivedAt` is not on `main` (branch retained for the design). Interview (PR #959) rework: model **TWO archive states as DB state, not text** — **Form A INVALID/DUPLICATE** (terminal, never reactivates, almost always follows a person-merge = "M18 wearing an archive costume"; NOT a purge — keep all history/audit) vs **Form B IDLE/AGED-OUT** (reactivatable on re-login). Add a **no-active-items precondition** + specific cleanup list, **state-aware self-reactivation**, and archive that **actively unsubscribes lists** / un-archive that does **NOT** auto re-add (ties SYNC-2, CM4). #959's proposed single-state block-all guards conflict with the reactivation model | CREATE | IN-DESIGN | M | ? | B,PR#959(closed-unmerged) | #1228 (open) |
| M5 | Cascading removal on revoke/deny (pull enrollments + pickup auths + list subs). NOTE (PR #965): the cascade design does **enrollments only** — the **pickup-authorization cascade leg is not addressed**; list-subs = CM4 | CREATE | NEEDS-DESIGN | M | remove enrollments/subs by hand | B | #1229 (open) |
| M6 | Age-based **individual agreement per ≥18 child** (child-of-signer, not spouse) — today one household-level agreement. NOTE (PR #1328): needs a **family-facing "why this + what to do" surface** for the two false-positive edges — graduating senior flagged a cycle late, and spouse-vs-child can't be told apart in data (message: ignore, or mark spouse a lead); copy+placement TBD | ENHANCE | NEEDS-DESIGN | M | ? | B,E | #1224 (open) |
| M7 | "Students ≥18 as of Sept 1" report — current AND next member-year | CREATE | READY-FOR-DEV | S | none | B | #1230 (open) |
| M8 | Age-based family cap: <25 same-address may stay; ≥25 own family | CREATE | DECISION | M | handle case-by-case | B | #1231 (open) |
| M12 | **Address UX** — street-address autocomplete/validation | ENHANCE | READY-FOR-DEV | S | type address by hand | F | #315 (open) |
| M13 | Settings PUT bug: one env-rejected field 400s all membership settings | FIX | READY-FOR-DEV | S | save fields one at a time | F | #1130 (open) |
| M14 | Membership-process **visualization** for audit/ops | CREATE | NEEDS-DESIGN | M | ? | F | #1152 (open) |
| M15 | **Enforce certifier ∈ member-family invariant** at API/seed — HIGH-RISK (a certifier can grant tool use = one of the org's largest risk items) | ENHANCE | READY-FOR-DEV | S | ? | F | #164 (open) |
| M16 | BLOCKED membership — **PARTIAL**: the alert is fixed (`MembershipFlowStepper` shows "needs attention, team notified" — board-override-only). Remaining: right-column status card (`page.tsx:985-992`) has NO BLOCKED case → still shows the generic #879 "follow the steps" card, now CONTRADICTING the alert. Add an `inStatus==="BLOCKED"` branch. **#879 closed but never fixed.** | FIX | READY-FOR-DEV | S | the red alert already tells them (card just contradicts) | D2,verify | #879 (closed — NOT fixed) |
| M19 | **Hide archived households from the many views** that don't filter them yet (follow-on to M4/#959 soft-archive — archive blocks activity but many read surfaces still show archived families). #959 **proposed** an `ACTIVE_HOUSEHOLD_WHERE`/`_PERSON_WHERE` shared filter as the reuse vehicle, but #959 **closed unmerged — no such helper exists on `main`**, so #1232 must build the shared active-filter itself (nothing to reuse). | ENHANCE | NEEDS-DESIGN | S | ? | owner,PR#959(closed-unmerged) | #1232 (open) |
| M20 | **View membership agreement as PDF, view-only** — read the agreement without triggering a Zoho Sign session (applicants previewing before committing + members re-reading their reference copy). Design calls: static current-template PDF vs the person's own signed copy (Zoho download); ties CM12 templates + CM13 policy library | CREATE | NEEDS-DESIGN | S | ask board / start-then-abandon a Zoho sign flow | owner | #1233 (open) |
| M21 | **Alumni pipeline** (Q74): students age out → alumni relationship worth modeling — keep the door open for the classic alumni→mentor return (list membership, status distinct from lapsed member, SA1 BG trigger already fires when they return as adults). Scope TBD | CREATE | NEEDS-DESIGN | M | nothing — alumni just disappear | owner | #1234 (open) |
| M22 | **Application archive/restore must record destroyed state at archive time, not infer it** — DESIGN FLAW (rules-fold): restore today walks the audit log for the archiving entry and reads the prior state out of it; a pruned log or a reshaped audit record leaves an application that cannot be put back. Capture the collapsed state when the archive decision is taken. | FIX | NEEDS-DESIGN | S | ? | rules-fold | #1430 (open) |
| M23 | **Don't re-prompt a household that deliberately shares one contact address** (rules-fold) — a single shared address between members is a deliberate answer, not a missing second contact; intake/validation must not treat it as an omission. Ties the RB10 "≥1 reachable contact" floor. | ENHANCE | NEEDS-DESIGN | S | ? | rules-fold | #1431 (open) |
| M24 | **Require a name on every Person; retire the kiosk email-prefix fallback** (rules-fold) — the kiosk shows the local-part of an email when a person has no name recorded; requiring a name on Person removes the need for that fallback entirely. | ENHANCE | NEEDS-DESIGN | S | kiosk shows email-prefix | rules-fold | #1432 (open) |
| M25 | **Youth school-enrollment status is not captured** (policy divergence; moved Programs→Membership) — POLICY SHORTFALL: policy requires a youth without a high-school diploma or equivalent to be enrolled in school; the app has no field for it, so the requirement cannot be checked. | CREATE | NEEDS-DESIGN | S | ? | divergence | #1442 (open) |

## 2. Programs & Enrollment  (prefix P)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| P1 | **Program → Instance → Event 3-tier restructure** (insert ProgramInstance; move roster/vols/fee/lead/capacity/dates/age-limits down). **Open problem from PR #1197 (w/ P25):** list-opt-out suppression keys on `(person, target, scope=program:<id>)` — teams persist year-over-year with reused group addresses; if instance-id changes yearly, suppression silently resets each year; if it doesn't, a one-time unsubscribe suppresses years later for a different child. P1's design must decide **which identity (team vs instance) opt-outs bind to**. Parked PR #953 CLOSED → phase-1 (additive tier + backfill) tracked as #1361 | ENHANCE | IN-DESIGN | XL | use flat Program model (no instance tier) | B,C,E,F | #155, #152 (open); #1361 (phase-1) |
| P2 | **Seat reservation / capacity holds** (temp hold, expiry, convert to enrollment) — no schema today | CREATE | NEEDS-DESIGN | M | ? | B | #1235 (open) |
| P3 | **Waitlist** for full programs (notify on capacity; queue-vs-notify-all open Q) | CREATE | NEEDS-DESIGN | M | ? | F | #942 (open) |
| P4 | **Auto-close enrollment** when pending+active ≥ max | CREATE | READY-FOR-DEV | S | ? | F | #82 (open) |
| P5 | Program **archive / un-archive** (`Program.phase` has no ARCHIVED) | ENHANCE | READY-FOR-DEV | S | ? | B | #1236 (open) |
| P6 | Shopify **auto-archive** finished programs + empty-category error warnings | CREATE | NEEDS-DESIGN | M | ? | B | #1237 (open) |
| P7 | **Shopify↔system capacity reconciliation** — core gap **FIXED merged (#1189: reconcile Shopify inventory on manual comp-add)** — comp-add now bumps Shopify. Residual (open #1345): surface Shopify seat notices on roster add/remove. capped↔uncapped transition stays a SEPARATE parked gap (§ Consciously not modeled — manual). (NOT #625 — that's pricing/CO6) | ENHANCE | READY-FOR-DEV | S | ? | B,V2,merged | #1345 (open, residual) |
| P8 | Program-leader **custom enrollment "key info" fields** (custom-question schema) | CREATE | NEEDS-DESIGN | M | ? | B | #1238 (open) |
| P9 | **Copy a program** (carry desc/doc links year-to-year, re-price) | CREATE | READY-FOR-DEV | S | recreate the program by hand | F | #156 (open) |
| P10 | Time-limited **member exclusivity** ("member-visible until date X" — not binary Member-Only) | ENHANCE | NEEDS-DESIGN | S | ? | F | #152 (open) |
| P11 | Program removal: 15-day warning + leader **Pause** (30d, once/yr); privacy-preserving "Incomplete Membership" label | CREATE | NEEDS-DESIGN | M | ? | B | #1239 (open) |
| P12 | Program-removal enforcement (stale/grace/expiry, scheduled) | CREATE | NEEDS-DESIGN | M | remove stale enrollments by hand | B | #1240 (open) |
| P13 | Manual-only programs (no Shopify limit; payment follows enrollment) | CREATE | VERIFY | S | ? | B | #1241 (open) |
| P14 | **Checkin → public Google Calendar feed** (Q83): programs/events created here publish to the website's Google Calendar. MUST include **display rules for cancellations + last-minute moves** (weather reactions etc.) so the public view never gaslights people — a changed event shows AS changed, not silently swapped. (Parked PR #952 CLOSED → its narrow .ics-export slice is tracked separately as #1360; P14 here is the full live feed.) Ties CM11, CM14, P24 | CREATE | NEEDS-DESIGN | M | hand-edit the Google Calendar | B,owner | #1242 (open); #1360 (.ics slice) |
| P15 | Volunteer↔instance assignment (leader assigns; volunteer self-removes) | VERIFY | VERIFY | S | ? | B | #1243 (open) |
| P16 | Youth enrollment rules — **DECIDED: disallow** under-18 self/household enrollment now (2026-07-22); richer rules (limit / parent-notify / slot-reserve) deferred to backlog-later | ENHANCE | READY-FOR-DEV | S | ? | F | #167 (open) |
| P18 | Dead routes: wire-or-delete `/publish` (#476) + `/settings` (#477); port lost validation/guards | FIX | READY-FOR-DEV | S | ? | F | #476, #477 (open) |
| P19 | Program-date **time display** off-by-one (UTC/local) — **a slice of PL17** (the broader date/time remediation). **SHIPPED**: the program display sites read the stored day unshifted, the writers store a day rather than a moment, and the columns are now `date`. Dropped from the backlog; the rest of the class stays open as PL17. | FIX | READY-FOR-DEV | S | ? | F | #1149 (open) |
| P20 | **My-Programs roster surface** for leads — roster + contact, attendance summary, stats, CSV (net-new read surface beyond the inbox; ties GC-ROLES/PL duties; parked PR #964 CLOSED by triage → scope source) | CREATE | NEEDS-DESIGN | M | ? | PR#964 | #1364 (open); PR #964 (parked, closed) |
| P21 | **T-shirt size on Person** — size field for participants + adults (some parents too), with **staleness/refresh policy** (size set too long ago → re-confirm reminder; refresh window likely age-based since youth grow — open design Q) | CREATE | NEEDS-DESIGN | S–M | collect sizes by hand (forms/spreadsheet) | owner | #1244 (open) |
| P22 | **Program "issues t-shirts" flag + missing-size ops surface** — program attribute; flag gaps to families; dashboard for ops/program leads (+assistant leads) of students in shirt-issuing programs with no/stale size (fits the existing compliance-dashboard `peopleMissingDob` + nav todo-count pattern) | CREATE | NEEDS-DESIGN | M | chase sizes over email | owner | #1245 (open) |
| P23 | **Program add-on offers → Shopify checkout (deadline-gated)** — design as a GENERIC "buy N by deadline so we can order" pattern; instance 1 = **t-shirts** (students AND adults, N comped per student + paid extras, comp policy TBD); instance 2 = **meal fees for parents at far-away competitions** (Q41). Reuses program↔Shopify variant + webhook plumbing | CREATE | NEEDS-DESIGN | M–L | manual order collection + side spreadsheet to vendor | owner | #1246 (open) |
| P24 | **Treehouse-wide / cross-program events** — an org-level event can appear on one or MORE program calendars (e.g. library visit with reps of 3 teams). Breaks the event-belongs-to-one-program assumption → event↔program many-to-many or org-event + program associations; affects attendance association + who's notified/RSVPs. Model it inside the P1 restructure rather than bolt-on; ties P14 calendar | ENHANCE | NEEDS-DESIGN | M | duplicate the event per program by hand | owner | #1247 (open) |
| P25 | **Year-over-year rollover for any recurring program** — a team is one case (Q47): on new-run creation, **auto-carryover of last run's participants** + **"first refusal" priority-enrollment window** + **board prices the new run**. Any program that runs every year carries its people forward, not just teams. Extends P9 copy + P1 restructure (program = persistent entity, run = instance) | CREATE | NEEDS-DESIGN | M | recreate + re-enroll by hand, dibs by email | owner | #1248 (open) |
| P26 | **External FIRST registration tracking** — enrollment here ≠ registered with FIRST (Q48). Phase 1: per-program **links to external registration** + P22-style gap dashboard ("enrolled here, not registered there"). Phase 2 ambition: **sync/expose FIRST registration state** in checkin. Texas wrinkle: students AND mentors must register with FIRST-NH **and** FIRST-Texas — two external registrations per person | CREATE | NEEDS-DESIGN | M | chase families by email, track in heads | owner | #1249 (open) |
| P27 | **Trip mode — temporary access expansion for off-site events** (Q44/Q54): during a trip window, chaperones/leads get the P20 roster surface incl **emergency contacts + allergies** on their phone; access is time-boxed to the event, then auto-revoked. Needs think-through (who grants, scope, audit). Ties P20, SA7, RB8 row-visibility | CREATE | NEEDS-DESIGN | M | printed sheet in a binder | owner | #1250 (open) |
| P28 | **Program "requires signed waiver" feature** (Q61): a program can require a waiver signed at/for enrollment (summer camps are big enough to need one); gate enrollment on it + track who signed (Zoho pattern like the membership agreement). Trips explicitly do NOT need one (covered by membership agreement; non-members don't come). Ties CM12 templates | CREATE | NEEDS-DESIGN | M | paper waivers in a folder | owner | #1251 (open) |
| P29 | **PL "paid?" reminder signal** — per-participant covered / in-process / reminder-due, derived from `ProgramParticipant.status` (NOT `FeePayment`); tier-gated to the PL band so full-pay/scholarship/plan stay indistinguishable. Split from FR7 (`docs/designs/PROGRAM_PAYMENT_VISIBILITY.md`); likely surfaces on the P20 My-Programs staff home; relates P13 | CREATE | NEEDS-DESIGN | S | PL asks the treasurer / checks Shopify | F | #1336 (open) |
| P30 | **BUG — program-leader picker uses an 18+ age floor; policy requires 23** (rules-fold) — both leader-selection search paths admit anyone 18 or over; the leader role carries legal responsibility and its floor is 23. Volunteers are unaffected (no age floor, and must not gain one). | FIX | READY-FOR-DEV | S | screen leader candidates by hand | rules-fold | #1433 (open) |
| P31 | **A run may narrow enrolment eligibility but never widen it** (rules-fold) — price is set by the board on the program definition; a single instance/run may tighten an age range or a member-only restriction but may never loosen one. A constraint on the ProgramInstance model; `PROGRAM_INSTANCE_RESTRUCTURE.md` is its likely home. | CREATE | IN-DESIGN | M | ? | rules-fold | #1434 (open, ties P1) |
| P32 | **Enrolling in a priced-but-unsellable program must fail closed, not strand** — DESIGN FLAW (rules-fold): a program that carries a price with nothing wired to sell it currently admits the enrolment, then the seat sits PENDING indefinitely and payment never arrives; the app detects and reports the state but still lets the enrolment through. Reject at enrolment. Distinct from P13 (deliberately manual-only programs). | FIX | NEEDS-DESIGN | S | ? | rules-fold | #1435 (open) |
| P33 | **Program dates are optional; policy requires a start and a bounded end** (policy divergence) — POLICY SHORTFALL: both start and end can be absent and nothing rejects it. A start must be required; an absent end should fall to fiscal-year-end, not stay empty. While missing, three rules silently change meaning: (a) **age eligibility falls back to the request moment — the exact thing the age rule exists to avoid** (safety-adjacent); (b) the catalogue reads a missing end as running indefinitely; (c) member pricing falls back to status alone. | FIX | NEEDS-DESIGN | M | ? | divergence | #1441 (open) |

## 3. Attendance & Facility  (prefix AT)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| AT1 | **Attendance inference** confidence / ambiguity / reconciliation **state** (association is deterministic single-match today) | ENHANCE | NEEDS-DESIGN | L | ? | B,E | #1252 (open) |
| AT2 | Attendance **ambiguity resolution** (overlapping programs; admin resolves; report flag; 30d reminder) | CREATE | NEEDS-DESIGN | M | ? | B | #1253 (open) |
| AT3 | **Visit management for staff.** Household-lead correction of a household member's visits, staff insert-for-others at an arbitrary past time, program-lead correction within their own program, and the `VisitSource` 3-way split. **SHIPPED (#1478); #1254 closed.** Ops (`isOperations`) on the visit-edit gate is still open in the design's §6.1. | ENHANCE | DONE | S | — | B,E,owner | #1254 (closed) |
| AT4 | **Volunteer-hour derivation from assignments** (today = residual present-but-not-enrolled, not from VolunteerDesignation) | ENHANCE | NEEDS-DESIGN | M | ? | B,E | #1255 (open) |
| AT5 | Hour **correction + manual entry**, incl. **user self-correction of their own hours** — a member edits or deletes their own visits, delete is a reversible tombstone, significant changes flag the board. **SHIPPED (#1357); #1256 closed.** Household-lead and staff scope shipped as AT3; the review screen is AT12. Who a flag reaches is still undecided (#1509). | CREATE | DONE | S | — | B,owner | #1256 (closed) |
| AT6 | **Two-deep compliance** (block last adult leaving lone student; 60s delay) — child-safety GAP. **POLICY SHORTFALL (divergence): the check counts raw adults present.** Policy requires **two adults who are volunteers, non-students, and unrelated / from different households**, present whenever any youth is, and must trigger on the drop **below two** — not only the last adult leaving (→0). Today any of those predicates can be false and the room still reads compliant. (Really a Safety item; id kept to avoid renumbering.) | CREATE | NEEDS-DESIGN | M | ? | B,E,divergence | #300 (open, bug) |
| AT8 | Offline kiosk store-and-replay + offline banner — **a slice of the AT14 kiosk-resilience epic** | VERIFY | VERIFY | M | ? | B | #1257 (open) |
| AT14 | **Kiosk resilience epic** (from PR #1216 design review) — beyond AT8's offline queue: layered health state-machine, recovery ladder (Chromium/wifi bounce, nightly+escalation reboot), reconciliation substrate + projection, server-side DLQ, `system-status/unsynced-scans` review panel, Phase-0 dead-path fixes. Includes a **bug**: 3s debounce swallows the 2nd badge so a fast keyholder double-badge can't close the facility (real window [3s,12s]); ties AT6/#300, AT9/#254. Several sequencing DECISIONS teed up. **Design MERGED to main (#1216 v2 + #1207 proposal).** | CREATE | IN-DESIGN | XL | ? | design-PR | #1347 (open) |
| AT9 | Force-close **race** (updateMany under per-participant lock → check-in survives close) | FIX | READY-FOR-DEV | S | ? | F | #254 (open) |
| AT11 | **Badge-print tracking** — `BadgePrint` model + facility-ops report of who has/hasn't had a badge printed in year X (net-new; parked PR #962 CLOSED by triage → scope source) | CREATE | NEEDS-DESIGN | S | ? | PR#962 | #1363 (open); PR #962 (parked, closed) |
| AT12 | **Admin hour-correction review screen** — surface how often self/hour corrections happen + let admins review them, NOT buried in the audit log (companion oversight surface to AT5). **Design MERGED to main (#1352 correction surface).** | CREATE | IN-DESIGN | S | read the audit log by hand | owner | #1258 (open) |

## 4. Safety & Compliance  (prefix SA)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| SA3 | **Scheduled household-composition sweeps** — recompute BG/safety obligations as membership/ages change: (a) flag a household that has lost its only background-checked adult (NO_CHECKED_ADULT → youth now uncovered) — **POLICY SHORTFALL (divergence): detection only; today the household stays ACTIVE with youth enrolled and nothing responds, so it reads compliant. The response (block / grace / warning) is a DECISION (see DECISIONS)**; (b) when a youth turns 18, recompute their own BG/agreement obligations. Catches gaps that emerge over time, not just at intake. | CREATE | NEEDS-DESIGN | M | ? | B,divergence | #1261 (open) |
| SA4 | BG-alert cascade (passive drift, program-lead alerts, escalation/re-notify). **Interview (PR #961) = the human-handoff half of the loop, in-scope with #961 (owner: "not satisfying SA4 = failing"):** at day-30 threshold loop **board + program-lead(s) IN PARALLEL**; monthly re-notify reaches **everyone** (student/household + board + lead). Program-lead gets the **overdue-student SIGNAL** (the conversation is in-person, not modeled). Board needs a **"reset the timer" control** on the compliance screen (`/membership-audit/compliance`) for a mistaken self-attest — **PARTIAL landed (#1412: confirm BG attestations + "a way back" = the reset/undo path)**; the parallel board+lead escalation loop remains | ENHANCE | NEEDS-DESIGN | M | ? | B,PR#961(closed-unmerged) | #1262 (open) |
| SA7 | Front-desk/keyholder access to **allergies** where food served — **DECIDED: keyholders CAN see** (2026-07-22). Grant keyholder/front-desk read of `allergies` | ENHANCE | READY-FOR-DEV | S | ? | F | #714 (open) |
| SA9 | **Families see their own tool certs** (Q71 — "probably yes"): household/member view of each person's tool levels (data is public-by-design already; this is a member-facing surface, not a new grant) | CREATE | READY-FOR-DEV | S | ask at the desk / check the posted board | owner | #1263 (open) |
| SA10 | **Cert-upgrade request** (Q71): a member proposes "I think my X cert should be upgraded" → tags/notifies that tool's certifiers to schedule the review. Lightweight queue, not a workflow engine | CREATE | NEEDS-DESIGN | S–M | ask a certifier in person | owner | #1264 (open) |
| SA11 | **Volunteer-onset background-check trigger (per-adult)** (rules-fold) — **any adult who starts volunteering needs their OWN check AT THAT POINT** (per-adult; one person's check never satisfies another's), event-driven, off-cycle — not only at intake/renewal or the annual sweep. Membership itself needs only **ONE** checked adult in the household (that's a membership gate, separate); this is a **volunteer** obligation. So how many adults are checked follows **who volunteers — one or both**, not "both because a second volunteers." SA3's sweep is the periodic backstop; **depends on SA1/#1260** (the per-adult-stamp fix — until it lands, one adult's check falsely reads as another's, defeating this trigger). | CREATE | NEEDS-DESIGN | M | no off-cycle trigger; caught late (or missed) by the annual sweep | rules-fold | #1429 (open) |
| SA12 | **Closing/departure guard must enforce two adults with a last youth, not keyholder-count** (policy divergence, youth-supervision) — POLICY SHORTFALL: the closing guard watches keyholders (last keyholder is stopped + made to confirm), so a NON-keyholder adult can leave a youth with only one remaining adult and nothing interrupts. Policy requires two adults on site whenever a youth is. Distinct from AT6 (guards the last adult →0, not the drop below two →1) and AT9 (force-close race). Reports the room compliant when it is not. | CREATE | NEEDS-DESIGN | M | none — silent | divergence | #1436 (open) |
| SA13 | **Primary-keyholder model** (policy divergence; moved Facility→Safety) — POLICY SHORTFALL: policy has ONE primary keyholder at a time, transferable only with the other keyholder's consent, and a departing primary must either transfer or close. None of that is modelled — the app tracks keyholder presence/count only. | CREATE | NEEDS-DESIGN | M | handled by people, untracked | divergence | #1437 (open) |
| SA14 | **Second-adult-volunteer requirement is not a scheduling precondition** (policy divergence; moved Programs→Safety) — POLICY SHORTFALL: a session can be scheduled without the required second adult volunteer; policy makes it a precondition of scheduling. Supervision-adjacent but distinct from the run-time two-deep items (gates scheduling, not the room). | CREATE | NEEDS-DESIGN | M | leaders arrange it by hand | divergence | #1438 (open) |
| SA15 | **No age minimum checked against a certification level** (policy divergence) — POLICY SHORTFALL: nothing stops a nine-year-old being recorded as certified, or someone under twenty-one being recorded as a certifier. Per-level age floors are unmodelled and unchecked. Depends on SA16 (tool category); ties M15 (certifier∈member-family). | CREATE | NEEDS-DESIGN | M | ? | divergence | #1439 (open) |
| SA16 | **Tool category is not modelled** (policy divergence) — POLICY SHORTFALL: the split between hand, heat, powered-motion and high-hazard tools has no representation, so the different age floors and supervision rules that follow from category cannot be enforced. Prerequisite for SA15's per-level age floors. | CREATE | NEEDS-DESIGN | M–L | ? | divergence | #1440 (open) |
| SA17 | **Self-attest accepts a bare PERSON_BG obligation** (split from SA1; PR #961 BLOCKER) — the nudge's `/membership` self-attest (#875) keys off the **household** process, so a per-person PERSON_BG obligation can't be self-attested → "you did your part → the reminders stop" can't land for the very population being nudged. Widen self-attest to accept a bare PERSON_BG. Required, not deferred (silence-on-attest = core customer service). | ENHANCE | READY-FOR-DEV | M | none — the nudge loop can't close | PR#961 | #1452 (open) |
| SA18 | **BG enforcement / grace-blocking posture** (SA1 slice 5) — an un-cleared PERSON_BG obligation NEVER blocks participation / check-in / renewal (warn-only by design). Whether/when it should **gate** (hard block vs grace period vs stay warn-only) is board-gated by SA5; deliberately not-yet-proposed. | ENHANCE | NEEDS-DESIGN | M | warn-only; board handles manually | B,D2 | #1453 (open) |

## 5. Finance — Receipts & Reimbursement  (prefix FR)   ·  PORT epic (receipt-app + ocr-function)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| FR1 | Receipt intake & capture (upload + file-hash dup detection; optional gmail-inbox monitor) | PORT | NEEDS-DESIGN | L | ? | A,B | #1265 (open) |
| FR2 | **OCR** interpretation (ocr-function; Claude SDK) — port with FR1 | PORT | NEEDS-DESIGN | M | ? | A,B | #1266 (open) |
| FR3 | Receipt approval/reimbursement **state machine** (approve/reject/review/retry/discard/resubmit). **Port requirement (Q86):** reimbursement request = part of the receipt-submission flow, and the **submitter must see their own status** ("did I get paid back?") — believed in the port's submitter-review states, VERIFY it survives the port | PORT | NEEDS-DESIGN | L | email/paper + ask the treasurer | A,B,owner | #1267 (open) |
| FR8 | **Card-statement ↔ receipt reconciliation** (Q87): match card-statement transactions against received receipts → "which transactions still lack a receipt" chase list. Today: by hand + QB reconcile function (+ printing the statement when bad). NOT in the Inventory port — net-new companion to FR1 | CREATE | NEEDS-DESIGN | M | hand-match against QB reconcile / printed statement | owner | #1268 (open) |
| FR4 | Tax explanation / tax-exception handling | PORT | NEEDS-DESIGN | M | ? | A,B | #1269 (open) |
| FR5 | In-kind donation identification (shares receipt system) | PORT | NEEDS-DESIGN | M | ? | A,B | #1270 (open) |
| FR6 | Backorder/preorder deferral + receive queue | PORT | NEEDS-DESIGN | M | ? | A,B | #1271 (open) |
| FR7 | `Fee`/`FeePayment` dead schema — **KILL** (no writer; payment truth is in the Shopify pipeline — `ProgramParticipant.status`+`shopifyOrderId`, `shopify_read`, `PaymentException`). Not replaced. 2-release drop: code refs first, `DROP TABLE` later. **DONE — Release 1 #1404 dropped all app/test reads; Release 2 dropped the tables.** Consumer feature split to P29 | DECISION | RESOLVED-KILL | S | keep inert | F,merged | #354 |

## 6. Finance — Expense & QuickBooks  (prefix FE)   ·  PORT epic (expense-app)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| FE1 | Expense + line-item model; per-line **owner approval** workflow | PORT | NEEDS-DESIGN | L | ? | A,B | #1272 (open) |
| FE2 | Budget owners; owner↔PN associations; owner-conflict resolution | PORT | NEEDS-DESIGN | M | ? | A,B | #1273 (open) |
| FE3 | **QuickBooks posting** + account mapping + vendor mapping/normalization + ambiguity resolution (heavy external coupling) | PORT | NEEDS-DESIGN | XL | ? | A,B | #1274 (open) |
| FE4 | Capital-asset queuing / identification / depreciation cycle. **NET-NEW beyond the port** (Q66): closing the loop per asset — assign an **asset number**, log it in **QB**, and **remind finance to put the sticker on the physical item** — an endpoint that doesn't exist in Inventory yet | PORT+CREATE | NEEDS-DESIGN | M | ? | A,B,owner | #1275 (open) |
| FE5 | QuickBooks **drift detection & reconciliation** (external edits to system-originated entries) | PORT | NEEDS-DESIGN | M | ? | A,B | #1276 (open) |
| FE6 | Membership/plan payment → QuickBooks sync (primary adult; conflict → Financial Ambiguity Record; retry→manual queue) | PORT | NEEDS-DESIGN | L | ? | B | #1277 (open) |
| FE7 | **Shop-hour fee → QB inter-class journals** (Q49, concretizes GC-PROGRAM-FINANCE): a base **per-hour fee charged to programs** (+ surplus for shop-using programs) virtually hits each program's P&L as **real QuickBooks journals between classes**. Checkin already has the hours; given **hourly rates + application rules** it could initiate the journals. **Cadence: journaled MONTHLY** (Q88). (Owner: more nuances exist, not yet specified) | CREATE | NEEDS-DESIGN | M–L | hand-built QB journals | owner | #1278 (open) |
| FE8 | **Budget-vs-actual status view** for program leads / assistant leads / program treasurer (Q62): approved operational budget + up-to-date actual expenses → live budget-status per program. **Cadence (Q88): semi-rolling/monthly — receipts presentable semi-live as they land, building-fee journals monthly; leads ask per-PROGRAM, not per-calendar-period.** View-only slice — REVIVES part of the parked "Program Budgets" (lifecycle engine stays consciously-not-modeled); depends on expense data landing (FE1–FE3) + FE7 | CREATE | NEEDS-DESIGN | M | treasurer's spreadsheet | owner | #1279 (open) |

## 7. Finance — Donations  (prefix FD)   ·  PORT epic (bulkdonation-app, income-app)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| FD1 | **Benevity** bulk-import + dedup + comment-rule engine + restricted-condition mapping + GL account map | PORT | NEEDS-DESIGN | L | ? | A,B | #1280 (open) |
| FD2 | Disbursement holds + resubmit; disbursement events/snapshots | PORT | NEEDS-DESIGN | M | ? | A | #1281 (open) |
| FD3 | Donation entry: online (Shopify), check/cash [board], in-kind [ops]; auto donation-receipt email | PORT | NEEDS-DESIGN | M | ? | A,B | #1282 (open) |
| FD4 | Income-app **QB reconciliation + conflict resolution** on already-ingested Shopify data (reuse s-read) | PORT | NEEDS-DESIGN | M | ? | A,B | #1283 (open) |
| FD6 | **Team sponsorship intake** — a company sponsors a specific team, often by **check** (Q40): income-intake gap — record, receipt, and **allocate to that team/program**. Adjacent to FD1 restricted-condition mapping + FD3 check/cash entry, but the per-team allocation leg is net-new | CREATE | NEEDS-DESIGN | M | check goes to QB by hand, allocation in heads | owner | #1284 (open) |
| FD7 | **Year-end giving statement** (Q75 — "decent idea"): annual per-donor tax summary of all donations that year. Natural once FD1/FD3/FD6 intake lands | CREATE | NEEDS-DESIGN | S | hand-built letters | owner | #1285 (open) |

## 8. Catalog & Inventory  (prefix CI)   ·  PORT epic (global-catalog-app, local-inventory-app, workflow-mapping-app)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| CI1 | **Global catalog**: GTIN items, categories, vendor-alias references, 3-pass matcher, proposals/supersession, provisional allocation, conversion challenges | PORT | IN-DESIGN | XL | ? | A,B | #1286 (open); design `docs/in-design/1286_GLOBAL_CATALOG_INTEGRATION.md` (#1814) |
| CI2 | **Org inventory**: locations, receive queue, delta apply, merge-conflict resolution, provisional resolution | PORT | NEEDS-DESIGN | L | ? | A,B | #1287 (open) |
| CI3 | Receipt line-item → **part association** (auto + manual exceptions); UoM conversion/quantity challenge | PORT | NEEDS-DESIGN | L | ? | A,B | #1288 (open) |
| CI4 | **workflow-mapping** orchestrator (receipt→catalog→inventory→expense glue; collapses in monolith) | PORT | NEEDS-DESIGN | M | ? | A | #1289 (open) |
| CI5 | Cross-system catalog sync (local↔global federation) | PORT | NEEDS-DESIGN | M | ? | A,B | #1290 (open) |

_Note: FR+FE+CI (+CI4 glue) are ONE dependency-chained pipeline — little value piecemeal (chip A). FD1 (Benevity) and FD4 (income QB-recon) are the two independently shippable finance ports._

## 9. Commerce & Payment Reconciliation  (prefix CO)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| CO1 | **Shopify member-segment pricing** (#929): auto-managed customer segment gates who redeems member/volunteer variants. NOTE: unentitled redemption of the minted `PRG{programId}-XXXXXXXX` member-discount code is now flagged `DISCOUNT_UNAUTHORIZED` at the money event — the orders/paid webhook, and the reconciler's forward pass recovering a missed one (`lib/programs/memberDiscountCode.ts`); flagged orders are not activated, and entitlement is never re-judged afterwards, so a later deactivation doesn't retro-flag settled orders. Interim, detection-only stand-in for this segment-gated design. Accepted window: codes live 48h, so entitlement can move between mint and checkout — judged at checkout | ENHANCE | IN-DESIGN | L | ? | C,D2,F | #270, #278 (open) |
| CO2 | **Validate payment webhook** before activation: amount/discount/product/code gate (`Membership_Process_ID` customer-controlled). **Design MERGED to main (#929 segment-pricing, which scopes #278 = segment-gated discount + webhook validation).** | FIX/ENHANCE | IN-DESIGN | M | honor system (the current state) | C,D,D2,F | #278 (open, security) |
| CO3 | Guest-checkout failure: member charged full price silently — nudge / post-purchase refund path. **DECIDED: accept risk FOR NOW** (2026-07-22), low priority; may revisit (nudge/refund) later — stays in backlog, not near-term | ENHANCE | NEEDS-DESIGN | S | member re-checks out / board refunds by hand | C | #1291 (open) |
| CO4 | In-flight-checkout cutover: old cart permalinks never expire; dual variant-id recognition + deprecation window | ENHANCE | NEEDS-DESIGN | S | ? | C | #1292 (open) |
| CO5 | **DiscountCodeRule registry** (board-managed coupon eligibility rules) | CREATE | NEEDS-DESIGN | M | ? | D2 | #1085-ref |
| CO6 | Pricing **drift auto-check**: our pricing settings vs Shopify actual (discounts/timing) | CREATE | NEEDS-DESIGN | M | ? | C,F | #625 (open) |
| CO7 | Shopify config-drift reconciliation (dev↔prod variant/config) + archive-status contract (#955) | CREATE | NEEDS-DESIGN | M | ? | D2 | #1293 (open) |
| CO8 | **Remove legacy 2-variant product-shape references** — the 2-variant shape is a problem; lingering references = a bug (not a keep/kill call). **Removal-plan design MERGED to main (#1327).** | FIX | IN-DESIGN | S | ? | F | #975 (open) |
| CO9 | Real-dev-store checkout testing promoted optional→required before segment-pricing phase 2 | CHORE | READY-FOR-DEV | S | ? | C | #1294 (open) |

## 10. Communications & Mailing Lists  (prefix CM)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| CM1 | **Mailing-list auto-sync** — design doc = `docs/designs/MEMBERSHIP_SYNC.md` (PR #1197, supersedes #1156/#1157): desired-state pure function + SyncState ledger + per-target population rules, consent/audit model, 4-PR rollout. Interim under-13 rule (13+ direct; leads of enrolled minors otherwise) pending board DECISION SYNC-1. Self-removal = first-class bi-directional intent, last-wins, no auto re-add (SYNC-2) | CREATE | IN-DESIGN | L | ? | B,D2,PR#1197 | #943 (open, adjacent) |
| CM2 | **Coverage-drop detection** (RESCOPED per SYNC-4 — NOT auto re-add): household loses its last synced lead → notification + board dashboard surface. Warn-only, matching the app's posture elsewhere; automation reconsidered after frequency/reasons learned | CREATE | IN-DESIGN | M | ? | B,PR#1197 | #1295 (open) |
| CM3 | Ghost / externally-added-unknown detection — shape decided (PR #1197): same `listMembers` call, reverse diff → surfaced on a screen (board / program-lead viewpoint); sync **never auto-removes anyone it didn't add**; bulk-remove = checkbox-select rows (incl. select-all), not "remove all ghosts" | CREATE | IN-DESIGN | M | ? | B,PR#1197 | #1296 (open) |
| CM4 | Cascading list cleanup on program/membership removal — **partially absorbed by CM1's engine** (boundary removals fall out of the desired-state diff); net-new bit = the **DENIED-newsletter exception** (SYNC-3: DENIED is the one removal from the otherwise-never-removed newsletter) | CREATE | IN-DESIGN | S | ? | B,PR#1197 | #1297 (open) |
| CM5 | ~~Scheduled compliance/reminder engine — email sends gutted~~ — **ACK'd, larger fix underway by another dev; OUT OF SCOPE this session** | FIX | (external) | — | ? | B,E | none |
| CM6 | **Per-program Google Groups, auto-managed** (Q55 spec): 1197 deliberately models **only the team list** (parents+students+volunteers); **parents-only + mentors-only lists explicitly FUTURE** (they exist today outside checkin). List addresses = fields on Program; **Slack config = its own table attached to Program** (non-null row may imply "uses Slack"). "Youth auto-included" = the liberal under-13 alternative held for board DECIDED 13+ for now (2026-07-22, SYNC-1); liberal option parked for future revisit | CREATE | IN-DESIGN | M | leads maintain Google Groups by hand | B,owner,PR#1197 | #1298 (open) |
| CM7 | Email deliverability / unreachable-address detection (bounce signals). Cross-link (PR #1197): Google Groups auto-ejects bouncing addresses — the sync must consult `Person.emailUndeliverableAt` before classifying an external absence as the person's choice | CREATE | NEEDS-DESIGN | S | ? | B,PR#1197 | #928 (closed, partial) |
| CM8 | **Program-creation email controls**: opt-in per leader + only active-membership recipients + resend-rate batching | ENHANCE | READY-FOR-DEV | M | ? | F | #1153 (open) |
| CM9 | **Batch large emails** (chunks, ≤5/sec to respect Resend limit) | ENHANCE | READY-FOR-DEV | S | ? | F | #1154 (open) |
| CM10 | **Newsletter enroll** — aligned w/ 1197: in-app comm-settings opt-out confirmed = one leg of the bi-directional intent model (SYNC-2). Population default: **1 household lead per family** on newsletter + members list; others join at discretion; no secrets — **13+ youth welcome on the members list** | CREATE | READY-FOR-DEV | S | ? | F,PR#1197 | #943 (open) |
| CM11 | **Event cancel notifies** registered participants (RSVP path ripped out — rescope) | FIX | READY-FOR-DEV | S | ? | F | #472 (open, rescope) |
| CM12 | Agreement/receipt **template management** [board] (Membership, Waiver, Key-Vol, Dual-Rel, Donation-Receipt) | CREATE | NEEDS-DESIGN | M | ? | B,C | #1299 (open) |
| CM13 | **Policy library in-app** — all org policies (source of truth = Google Drive) + bylaws + a procedure or two, visible + linked from the app. Curated link list (board-manageable, not a doc mirror); design calls: where it lives in nav, member-vs-public visibility, hardcoded vs settings-managed links | CREATE | NEEDS-DESIGN | S | hunt Google Drive / ask board | owner | #1300 (open) |
| CM14 | **Prospect path** (Q77): prospective families log in + subscribe to newsletter + get notified of programs — pre-membership account tier; open house = an event on the **public calendar**. Depends on newsletter (CM10) + public-facing calendar (P14-adjacent) landing first | CREATE | NEEDS-DESIGN | M | interest lives in someone's inbox | owner | #1301 (open) |
| CM15 | **Deploy-free email-template management** (from PR #1334/#1333) — board-editable subject/body for ~27 email flows via `EmailTemplate` table + registry + one-door `sendTemplated`. **Distinct from CM12** (contract/document templates). Also fixes a latent bug: `PROGRAM_ASSIGNMENT` falls through the switch and ships a literal `"System Action: PROGRAM_ASSIGNMENT"` body to lead mentors | CREATE | IN-DESIGN | M | edit copy in code + deploy | design-PR | #1333 (open) |

## 11. Platform, Admin & Automation  (prefix PL)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| PL1 | Aggregate **exception queue** (broader than #905 MVP: stuck processes + failed sends + mismatches). Design data point (PR #1197): owner REJECTED reusing any existing surface (Link Status/IntegrationErrorLog, PaymentException) for sync follow-ups — wrong domain, wrong word ("error"), and **different audiences need different viewpoints** (program-lead vs board vs newsletter) → new `SyncFollowUp` table (kind/audience-routed) + dedicated screens; self-removals route: members list→ops/board, program list→that lead, newsletter→no-op. PL1's "one unified queue" framing should absorb this audience-routing lesson | ENHANCE | NEEDS-DESIGN | M | ? | B,C,PR#1197 | #1302 (open) |
| PL2 | **Audit logging of PII reads** + reason field (today CREATE/EDIT/DELETE only, no READ, no reason) | ENHANCE | NEEDS-DESIGN | M | ? | B,E | #1303 (open) |
| PL3 | Audit-log event entities as **clickable links** | ENHANCE | READY-FOR-DEV | S | ? | F | #1151 (open) |
| PL4 | Program-leader **time-scoped contact access**. **RE-CUT (interview PR #963):** #963 built a parallel `/my-programs` EC route, but the existing `GET /api/programs/[id]` roster **still drags the full Person row (phone/email) + EC untimed/unaudited** to lead+core-vol+board → the new timed door is **theater while the old door is open** (owner: inconsistency is fatal). Re-cut as **time-scoping the EXISTING roster path**, two windows: **EC ±7d** (tight, incident) + **parent/participant contact ±90d** (prep/debrief); **allergies ride the ±7d** window (ties SA7). Roles = lead **+ assistant-lead + core-vol** (core-vols kept for on-the-ground safety; only non-core "other" vols excluded). Fail-closed on null dates **but surface must say WHY** | ENHANCE | NEEDS-DESIGN | M | ? | B,C,PR#963 | #1304 (open) |
| PL5 | **Auto-purge cron** for disposed/expired data (manual one-click disposal only today) | CREATE | NEEDS-DESIGN | M | ? | D2 | #913-ref |
| PL6 | Lifecycle: transactional outbox / DB CHECK constraints / `classify` badge + SQL view (was decided-deferred architectural) | ENHANCE | COND | M | ? | C | #1305 (open) |
| PL7 | s-read FUTUREWORK: projection DLQ, replay/reset-watermark admin ops, alarm wiring, in-VPC migrate-runner | ENHANCE | COND | M | ? | C | #1306 (open) |
| PL8 | **Orphan Student Alerts** (CUJ 7.5): dashboard alert for unclaimed parent accounts | CREATE | READY-FOR-DEV | S | ? | C,D | #1307 (open) |
| PL9 | SWR / data-fetching migration tail (Phase 7 ~30 files); resilient-load rollout. **Design MERGED to main (#925 resilient SWR loader + #716 hook-migration plan).** | CHORE | IN-DESIGN | M | ? | C | #1308 (open) |
| PL10 | Index page: command palette (Cmd-K), dynamic detail results, keyboard nav (nice-to-have) | CREATE | NEEDS-DESIGN | M | ? | C | #1309 (open) |
| PL11 | Test-runner split Jest/Vitest (#228) [monorepo conversion #214 done, Lambda infra #235 done] | CHORE | READY-FOR-DEV | M | ? | C,F | #228 (open); #214, #235 closed |
| PL12 | Dev tooling: `+ new persona` creation; dev-instance macro set; sysadmin-persona impersonation | ENHANCE | READY-FOR-DEV | S | ? | C | #1310 (open) |
| PL13 | Test coverage → ~80% (Phase 4 remaining 53 pages; shared RTL fetch/session helper prereq) | CHORE | READY-FOR-DEV | M | ? | C | #393 (closed) |
| PL14 | **Staleness auto-notification framework** — registry-driven daily household nudges + weekly board digest for aging renewals/trusted-adults/broken-emails (net-new; distinct from external CM5; parked partial PR #958, scope source). NOTE (PR #958): `Person.notificationSettings` exists but **nothing consults it** (not renewal/TA emails either) — honoring member opt-outs is a cross-cutting follow-up (ties CM10 + SYNC-2 intent model). **Live tracking issue = #1362** (staleness-notification engine); PR #958 = parked scope-source | CREATE | NEEDS-DESIGN | M | ? | PR#958 | #1362 (open); PR #958 (parked) |
| PL15 | **Annual org metrics report** (Q62): member-family count, total participant count, volunteer count, volunteer hours — the numbers the board hand-builds every year, from data checkin already has | CREATE | READY-FOR-DEV | S | hand-count from queries/exports | owner | #1311 (open) |
| PL16 | **Org task/todo board** (Q73): "here's what the Treehouse needs done" — one-time AND repeating tasks volunteers can see/claim. Lightweight chore board, not project management | CREATE | NEEDS-DESIGN | M | word-of-mouth / whiteboard | owner | #1312 (open) |
| PL17 | **Date/time canonical-layer remediation** — the class is now almost closed. **Done:** the program-date display slice (P19); every calendar-date reader UTC-pinned; age read from UTC fields rather than local ones; the visit-window and facility-trends bucketing; the single display-timezone source, so `formatDate`/`formatTime`/`formatDateTime` follow the configured org zone with `APP_TIMEZONE` as seed default and offline fallback only (#1522); and calendar-date storage, every semantic calendar date now a `@db.Date` column, which collapses the three DOB write conventions and closes the exact-match dedup miss that produced duplicate Person rows (was tied to M18). **Remaining, one item:** `calculateAge` reads UTC fields on both sides, which pins the birthday rollover to UTC midnight (7 PM Chicago), so an evening lookup can treat someone as a year older a few hours early. The fix is the callers passing the org-zone calendar day as `asOf` — a day comes from a day — not a local-field read inside the helper; `calculateAge`'s own comment names the upgrade. Standing rule: `docs/conventions.md`, "A day is not a moment". | FIX | READY-FOR-DEV | S | none; the exposure is the hours between UTC midnight and local midnight, on a birthday | design-PR | #1346 (open) |

## 12. Auth, RBAC & Security  (prefix RB)  — one item per proposed role (Q3)

| id | item | origin | readiness | size | Workaround | src | GH |
|----|------|--------|-----------|------|----|-----|-----|
| RB1 | Role: **Program Treasurer** (budget-owner / line-item approval) — is it a role? what does it deserve? | CREATE | DECISION | M | ? | B,C | #1313 (open) |
| RB2 | Role: **Finance** | CREATE | DECISION | S | ? | B | #1314 (open) |
| RB3 | Role: **Operations (Ops)** | CREATE | DECISION | S | ? | B | #1315 (open) |
| RB4 | Role: **Catalog Manager** | CREATE | DECISION | S | ? | B | #1316 (open) |
| RB5 | Role: **Key Volunteer** (non-RBAC; assignment → triggers contract signing) | CREATE | NEEDS-DESIGN | M | ? | B | #1317 (open) |
| RB6 | Role: **Assistant Lead** (attendance/roster + move meetings; NOT settings/pricing/enrollment). NOTE (PR #963 interview): the PL4 EC-access re-cut **needs assistant-lead modeled** (it's an intended grantee alongside lead + core-vol) — currently unbuilt | CREATE | NEEDS-DESIGN | M | ? | C,D2 | #437-ref |
| RB7 | **Admin role ambiguity** 🔴 ("admin" = isSysadmin some files, +isBoardMember others) — resolve, security-sensitive | ENHANCE | NEEDS-DESIGN | M | ? | C | #1318 (open) |
| RB8 | Declarative **row-visibility** enforcement (query-side), complements field-tier stripping (has shipped real leaks). PARTIAL relief merged (#957: stops raw-row echoes on household **write** routes + lead-gates renewal) — a slice of the leak class; the broad declarative query-side enforcement remains | ENHANCE | NEEDS-DESIGN | L | ? | C,F,merged | #1134 (open) |
| RB9 | Cross-system **identity reconciliation** — join the same human across Shopify/QB/Google on **email** (the join key). **Largely premature**: the only live facet (Shopify order-email → checkin Person/membership) is ALREADY the `PaymentException` `UNMATCHED_ORDER` engine; QB leg blocked on `GC-QB` (zero QB integration), Google leg blocked on `CM1` (no mailing list). Real net-new = an email-drift detector (person's Shopify/contact email ≠ checkin email → payments/list silently miss them). **Google-list leg now CONFIRMED + designed in CM1/PR #1197**: email changes actively propagate to every checkin-managed list (webhook + nightly, belt-and-suspenders); hard case = two household leads swapping/reusing a deliberately-shared address (real constituency); sync ledger stores applied-email per row and diffs at the email level. QB leg still blocked on GC-QB | CREATE | PARKED | L | ? | B,V5,V7,PR#1197 | #1319 (open) |
| RB11 | GAP-2 **drift-guard CI ban** (fail on new getServerSession / unregistered prisma route) — re-armable | ENHANCE | READY-FOR-DEV | S | ? | C | #1320 (open) |
| RB12 | `handler()` consolidation end-state (~75 withAuth routes → handler default) + response-envelope phase 2 | CHORE | READY-FOR-DEV | L | ? | C | #721 (open) |
| RB13 | §7.7 security library extraction (`@checkin/security`) | CHORE | NEEDS-DESIGN | L | ? | C | #281 (closed) |
| RB14 | Unbuilt scopable+sensitive routes pending scoping (`OPT_OUT_PENDING_ROUTE` set) | CREATE | NEEDS-DESIGN | M | ? | C | #1321 (open) |
| RB15 | `@sensitivity` classifications on vendored Prisma schemas (monitoring-db, s-ingest-core) — pre-commit gate will block | CHORE | READY-FOR-DEV | S | ? | F | #236 (open) |
| RB17 | Role-assignment UI won't scale at ~10 roles; role-search results cut off | ENHANCE | READY-FOR-DEV | S | ? | F | #161, #1150 (open) |
| RB18 | Auth-app: **do NOT port** — checkin RBAC supersedes (recorded for scope clarity) | — | — | — | ? | A | none |
| RB20 | Vocab rename ledger (UNFINISHED.md): leadMentor→ProgramLeader, staff→Treehouse Volunteer, dues→membership-fee, ToolLevel explicit rank, dependent retire+BUG-2, payment "certified"→"manual", **+ "Review/Reviewer" term convergence** (BG-reviewer / attestation-reviewer / membership-review / trusted-adult "decider" — decide one canonical word or keep distinct), etc. | CHORE | READY-FOR-DEV | M | ? | C | #1322 (open) |
| RB21 | **Eliminate `dangerously_allow_all_data_access`** (from PR #146 design proposal, 2026-05-14) — replace the stripper-bypass used by ~23 routes with a transformer registry (~10 primitives). Security-boundary, own-PR discipline (ties RB16/#1133) | ENHANCE | NEEDS-DESIGN | L | ? | design-PR | #1348 (open) |
| RB22 | **`'member'` field-visibility TIER — rename to `orgMember` or bless as-is?** (UNFINISHED Phase-4 OQ-1) — the security *visibility* tier `'member'` (a typed access contract, `member`-view holds member+public) is a different axis from the org-membership noun and was deliberately left OUT of the Phase-4 rename. Open question whether a rename is even wanted (reads fine as "member-visible"). If done: ~34 `'member'` tokens in `registry.ts` scope arrays + one `@sensitivity:member` tag + generated classifications + parser guards — **partly tsc-blind**, needs the full jest security suite as the net (over/under-grant risk). Its own slice, low priority. | ENHANCE | DECISION | S | leave as-is (works) | UNFINISHED | none |

---

## Reverse coverage — open GH issues → backlog mapping

All 40 open issues are associated above **except** these, which are pure bugs/chores that don't merit a backlog *feature* (track as-is in GH), or are stale/close-candidates:

- **Closed by hand** (2026-07-20, audit-confirmed done): #237, #235, #160 — no longer tracked here.
- **Keep/kill decisions**: #354 (FR7), #975 (CO8).
- **Rescope**: #472 (CM11 — RSVP ripped out).
- Everything else maps to an item above (see GH column). No open issue is unaccounted-for.

## Near-term priority signals (from Q33 triage)

Owner-assigned relative priority. Not a schedule — a lean. Still high-level (discovery), no deep-dive committed.
- **A convergence candidate (not confirmed the priority):** the **receipt → catalog → inventory → QB** pipeline (GC-INVENTORY + GC-QB + expense port). Noted as a natural grouping, not an agreed center of gravity. See TOPDOWN.
- **Soon / near-top:** **M6** per-≥18-child agreement · **M1** board "who hasn't paid since Sept 1" dashboard · **SA6** delete-DOB for all adults (#1165) · **M15** enforce certifier ∈ member-family (#164, HIGH — certifier can grant tool use).
- **Short term:** **P1** program→instance restructure · **P4/#82** auto-close enrollment · **M13** settings-400 bug (#1130) · **M16** BLOCKED-recovery flow · **P14** program calendar load (Google Calendar).
- **Short–medium:** **P9** copy-program (#156) · **P13** manual-only-program flag (ops/leader manual-add bypassing Shopify cap).
- **Medium term:** **CO1** Shopify segment-pricing · **P2/P3** seat reservation + waitlist (#942) · **P10** member-visibility timing (#152) · **CO2/#278** honor-system discount / process-ID (exploiting it is an ethics violation → unlikely short-term).
- **Medium-ish, other-dev-owned** (may land in passing): comms — **CM11** event-cancel-notify (#472) · **CM8/CM9** program-email controls + batching (#1153/#1154).
- **Discuss / tee up:** **RB7** admin-role ambiguity (a decision conversation).
- **Soon, pending buy-in:** **RB8** declarative row-visibility (#1134) — owner advocating with others.
- **Needs real data first:** **AT1/AT2** attendance inference/ambiguity — assess with real data before scoping.
- **P7** Shopify↔capacity reconciliation — gap CONFIRMED (V2): comp-add path skips `adjustProgramInventory`. No longer "investigate"; it's real.
- **Lower:** **M2** state-maintenance cron (want the dashboard, not the cron) · **PL2** PII read-audit.
- **In-flight (lands ~this week):** **CM** mailing-list automation (fixes the email bug).
- **Parked:** **M9** corporate membership → Consciously not modeled.

## Parked partial PRs (post-first-release — scope sources, NOT done)

13 open `post-first-release` PRs are **done-ish but underspecified** (same disease as past PRs). **Mine for scope, do NOT treat as complete or merge-ready.** They show what someone already attempted for each item — input for the eventual issue-writing. Full detail: `sources/post_release_pr_map.md`. Several are *partial even as code*.

| INDEX item | parked PR | how complete (per PR body) |
|-----------|-----------|----------------------------|
| M4 archive family | #959 (CLOSED unmerged) | nothing shipped (`archivedAt` not on main); interview reworked M4 to two-state (#1228) |
| M5 cascade removal | #965 (closed) | tracked as #1229 (enrollments only; pickup-auth leg open) |
| P5 program archive | #954 (closed) | tracked as #1236 |
| P6 Shopify auto-archive | #955 (closed) | tracked as #1237 (listing archive only; no empty-category warnings) |
| P14 calendar load | #952 (closed) | .ics slice tracked as #1360; full feed = #1242 |
| CM1 mailing-list sync | #960 (closed) | superseded by MEMBERSHIP_SYNC #1197 / #943 |
| PL4 time-scoped contact | #963 (OPEN) | interview re-cut PL4 (#1304) — theater vs old roster door |
| SA1 BG automation | #961 (OPEN) | student-nudge slice; #1260 now = the 🔴 per-adult-stamp safety defect (design PR-references it, no close) |
| P1 program→instance | #953 (closed) | phase-1 tracked as #1361 |

_Merge health: #960 + #1109 CONFLICTING (rebase); other 11 mergeable=UNKNOWN (GitHub hasn't recomputed — re-poll, not a clean signal)._

## Consciously not modeled (no real timeframe)

Deliberately parked — real concepts, but we do not intend to model them in any foreseeable timeframe.
Not dropped (they're valid), not backlog (no plan to build). Revisit only if priorities change.

| item | why parked | src |
|------|-----------|-----|
| **AT7** — age-based shop/tool state from who's present | No control point (system doesn't lock shop doors/tools) → tracking has no value. Distinct from two-deep (AT6, which IS in scope). | B,C · Q12 |
| **Capped↔uncapped Shopify auto-sync** — editing `Program.maxParticipants` ACROSS the null line (uncapped→cap, or cap→uncapped) | **Stays manual for now (owner, 2026-07-25).** `maxParticipants` = number (capped) or `null` (uncapped/sells-forever); the Shopify variant mirrors it via `inventory_management` ('shopify' vs `null`). They align at creation. The gap: an edit across the null line can't do the `newMax-oldMax` delta math (can't subtract `null`) AND needs Shopify's tracking flag flipped (start/stop tracking) + stock set/cleared — which the adjust-by-delta call doesn't do. Today: code detects it, **skips Shopify, logs a warning, tells the admin to fix by hand** (`route.ts:241-247`). Rarer path than comp-add (P7); warn-and-manual is acceptable. Auto-flip left unbuilt on purpose. | owner · P7-adjacent |
| **Repeat-donor CRM** — recurring-donor relationships, thank-yous, next-year asks | Heavily deferred (owner: "not in the next 2 years"). Intake/receipting IS in scope (FD1/FD3/FD6/FD7); the relationship layer is QB/Benevity's lane for now. | Q76 |
| **Machine-status comms** — "laser down this week" member notice | Too rare to build for. Heavily deferred. | Q82 |
| **Program Budgets** — budget lifecycle (draft→Board approve→carry-over/revert), incl. much of GC-FIN-CONTROL's budget layer | Very low priority; not painful. Expense/receipt→QB is the pain, not budgeting. **Partial revival (Q62): the read-only budget-vs-actual VIEW is now FE8** — the lifecycle engine stays unmodeled. | TOPDOWN GC-FIN-CONTROL |
| **Formal data-subject rights + retention/disposal engine** — Know/Correct/Delete requests, retention schedule, legal-hold | Handled manually; a subject request has never been received. Only stale-membership auto-purge (M3) stays in scope. | TOPDOWN GC-DATA-RIGHTS · Q17 |
| **Data-security ops** — 2FA/backups/unique-accounts/no-remote-access | Handled externally / already in the infra repo (AWS). Not app work. | Q18 |
| **Financial-controls enforcement** — COI/kinship engine, segregation-of-duties enforcer, threshold *blocking* | Replaced by a flag→human-checkoff→audit model (Q14); the app records/routes, humans enforce. | Q14 |
| **Scholarship cap engine** — 20%/50% caps, budget-line automation | Board decides case-by-case, each unique; fine as-is. | Q25 |
| **Facility/shop/incidentals fee build** | Fees live in Shopify, paid by a few folks; no app build needed. | Q25 |
| **Payment-plan Shopify flow** | Payment plans handled directly in QuickBooks; not building a Shopify flow. | Q25 |
| **M9 — Corporate / Org-Partner membership** | Not needed in a real timeframe (Q33). | Q33 |

## Dropped — confirmed built (not backlog)

**RB19** — pentest email-enumeration oracle: verified **already closed / not exploitable** (fix-chip made no code change, 2026-07-21). Dropped.

**Obsolete (2026-07-21):** SA2 wipe-polluted-blanket-BG-**DATA** — no *pre-import* polluted rows remain (everyone re-imported per-adult after the DB change). **⚠ CORRECTION (2026-08-01):** the earlier speculation that this *also moots the blanket-stamp→per-adult CODE defect* was **WRONG** (verified vs main while scoping #1260). The `review.ts:305` blanket `updateMany` never stopped — new pollution accrues on **every** household clearance. That is a **LIVE critical safety defect** and is now **SA1 / #1260** (not dropped, not moot).

**SA1 "BG automation remainder" DECOMPOSED (2026-08-01; slice statuses CORRECTED while scoping #1260, verified vs main):** **cron cohort-open** = BUILT (Trigger A, `cron/person-bg-annual`) · **consent link/email** = **NOT built** (board-manual submit only, no in-app orchestration; #961 territory) · ~~supplier affirmation~~ = **PHANTOM slice — NOT REAL** (owner-confirmed 2026-08-02: the BG supplier is **PDF-only, no API**, so there is nothing to programmatically affirm; the term propagated undefined from an early deferred list and was never a feature — dropped) · **blanket-stamp→per-adult** = **SHIPPED** (#1470, SA1/#1260; my earlier "MOOT" was WRONG) · **enforcement/grace** = **SA18** (board-gated by SA5). Plus **SA17** self-attest split. Escalation half = **SA4**.

**SA1 blanket-stamp→per-adult BG subjects — SHIPPED (#1470, 2026-08-07):** a household
clearance now stamps only the adult the reviewers named, and the board gets a worklist for the
stamps the old blanket write left behind. Rules live in `docs/rules/membership.md` § background
checks.

**Verified built during triage (2026-07-21), removed from buckets:** M10 volunteer-household pre-designation (`/membership-ops/volunteer-memberships`) · M11 intake-notes → surfaced to reviewer (`membership-ops/review`, `Household.intakeNotes`) · SA5 BG posture (29mo, enforced at renewal) · SA8 dual-relationship = Trusted Adults · RB10 dual-email = 2-account model (#286 closed) · FD5 banker = board (no role).

**Merged to main (verified via rebase 2026-07-25), removed from buckets:** **AT10** unknown-DOB fails-open in two-deep → FIXED, now fails closed (#1353/#300) · **AT13** visit-edit UI/API mismatch → FIXED, board reaches the visit-edit UI (#1350/#1259) · **M18** person-merge orphaned/non-controlled email → FIXED via 3 merge-fixes: emailSuppressed carry (#1332), login-identity unit (#1329), tombstone `.invalid` domain (#1331); #1225 closed · **SA6** delete-DoB for adults → BUILT (#1326 "delete DoB for all adults (26+)"; #1356 declared-adults-still-supervise follow-up); #1165 closed · **P17** staff-household enrollment ban server-side → BUILT (#1009 "disable Add Participant & Grant Membership for staff households").

**Merged/resolved (2026-08-01):** **RB16** boundary-isolation required-check → DONE — #1132 (CODEOWNERS gate) + #1133 (isolation job now a required status check on main) both closed. Was Q38.

From chip E (verified in code) + D2 (landed): renewal BG re-trigger + no-email-lookup (A7), reviewer-sets-volunteer (A14 core), trusted-adults dedup+revoke (A15), emergency-contact external check (A16), **RSVP subsystem** (B11), **recurring events** (B12), keyholder warn + forced-signout (C6/C8), orphaned-payment queue (D21), payment-plan keyholder-invisibility (D22), reviewer anti-collusion (F9), denied-login block (G2), system metrics (G13), duplicate-visit detection (#563), allergies-on-add-member (#800), Zoho auto-send contracts (#189), Shopify match-audit report (#1048). Full evidence in `sources/verification.md` + `sources/pr_deferred_landed_check.md`.

## Epics (span buckets)
- **E-PIPELINE** — Receipt→Catalog→Inventory→Expense (FR* + CI* + FE* + CI4). PORT, XL, needs-design. Ships bundled or not at all.
- **E-FINANCE-INDEP** — Benevity donations (FD1) + income QB-recon (FD4). The two independently shippable finance ports.
- **E-PROGRAM-INSTANCE** — P1 restructure + dependents (P7, P10, capacity). IN-DESIGN, don't-start; gated on CO1.
- **E-SEGMENT-PRICING** — CO1/CO2/CO3/CO4 + CO9. Shopify member/volunteer entitlement enforcement.
- **E-MAILING** — CM1..CM6 (Google-Group foundation + rules + cleanup). Gated on CM1.
- **E-BG-AUTOMATION** — SA1..SA4. Board-gated by SA5 decisions.
- **E-MEMBERSHIP-LIFECYCLE** — M1/M2/M3/M5 state machine + maintenance.
