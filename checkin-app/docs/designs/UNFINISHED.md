# UNFINISHED — running followup ledger

Open decisions, deferred fixes, and not-yet-built items surfaced during the
2026-07-02 vocabulary sweep. Decided terms are recorded in
[../VOCABULARY.md](../VOCABULARY.md); this doc holds what's left to *act on*. Add
sections freely — we'll find more. Nothing here is implemented; investigation only.
(Audited against `main` 2026-08-08: everything below is still open. Items that
resolved have been moved to *Considered and dismissed*.)

**Legend:** 🔴 high-priority / risky · 🟡 decision needed · 🟢 mechanical fix ·
🔵 aspirational (not-yet-built) · 📖 record-in-dictionary only

---

## 🔴 Admin role ambiguity — its own discussion, do NOT touch inline

"Admin" is **not a column** (no `isAdmin` on `Person`) — a loose derived label that
resolves to **different role sets** in different files:

| Site | "admin" means |
|---|---|
| [shopNav.ts:29](../../src/lib/shopNav.ts#L29) | `isSysadmin \|\| isBoardMember` (either) |
| [orgAccount.ts:9](../../src/lib/orgAccount.ts#L9) | reads as both-required |
| [api/roles/route.ts:7](../../src/app/api/roles/route.ts#L7) | gate `['isSysadmin','isBoardMember']` (either) |
| [settings/roles/page.tsx](../../src/app/settings/roles/page.tsx) | Sysadmin / Board Member as **separate** columns |

Real flags: `isSysadmin` ([schema.prisma:102](../../prisma/schema.prisma#L102)),
`isBoardMember` ([schema.prisma:104](../../prisma/schema.prisma#L104)).

**Why risky:** if "admin" gates a sensitive action, a mismatched meaning is an
over-grant (board gets access it shouldn't) or under-grant. Product owner:
"ambiguity bad," and **too risky to change inline** — dedicated session required.
Also folds in the **privileged-"staff"** uses (`isStaff = isBoardMember ||
isSysadmin` [trusted-adults/route.ts:50](../../src/app/api/trusted-adults/route.ts#L50);
"staff-only" rosters [events/[id]/route.ts:55](../../src/app/api/events/[id]/route.ts#L55)).

**Decision to make:** (1) admin = sysadmin only or sysadmin+board? (2) single
canonical `isAdmin(user)` helper replacing scattered `||` checks? (3) reconcile
privileged-"staff" onto it. (4) audit every call site for over/under-grant.
**Until then: do not change any admin/`isStaff` gate.**

---

## 🟢 Background-check verbs (decided)

**✅ A reviewer *reviews*, *attests*, and two attestations *clear* the check**
([../VOCABULARY.md](../VOCABULARY.md) › Background check). Four copy/identifier
renames, all ops-facing or internal — no schema, no `src/security/`:
- The reviewer queue asserts the report's content rather than the reviewer's
  judgement: "check is clean" on the row button, in the modal title, confirm label
  and both body branches (`membership-ops/review/page.tsx`, 5 strings + 8 test
  assertions). All become *attest*, and the outcome is named as the **noun** —
  `clear` as a verb on a button next to "Reject" reads as *reset*
- "Clear approvals" → "Discard approvals" (`membership-ops/applications/page.tsx`,
  button + confirm label + comment; 2 test assertions)
- The whole erase path for a person's background-check date is built on `clear` —
  handler, button, modal title, confirm label, toast
  (`membership-audit/compliance/page.tsx`, 8 sites + 4 test assertions). Becomes
  *remove*, the verb its own body text already uses
- `selfAttestBgConsent` → `selfRecordBgConsent` (~17 refs / 5 files; the
  `/api/membership/bg-consent` route path is unchanged). Keeps the `self` prefix:
  `markBgConsent` is exported and called from seven places, so a bare
  `recordBgConsent` wrapping it would be a coin flip at every call site

**Do not "fix"** `AttestationResult.result` or the `PENDING_BG_REVIEW` /
`PENDING_BG_CLEARANCE` misnomer. Both are wrong and both stay: renaming either
reaches the schema, a migration, and `src/security/`. _(VOCAB #9)_

---

## 🟢 "lead mentor" → "Program Leader" (decided)

**✅ Adopt "Program Leader"; retire "lead mentor"** (policy term). ~256-ref rename:
- `Program.leadMentorId` → `programLeaderId`
- relation `leadMentor` / `@relation("ProgramLeadMentor")` → `programLeader` / `"ProgramLeader"`
- `Program.leadMentorNotificationSettings` → `programLeaderNotificationSettings`
- `Person.programsLed` relation retargets (name can stay)
- "Lead Mentor" UI copy (63 refs) → "Program Leader"

Watch tsc-blind escapes (Prisma relation strings, mocks). _(VOCAB #7)_

---

## 🟢 "staff account" → "Treehouse Account"

Org-domain (`@innovationtreehouse.org`) account sense: rename `isStaffAccount` →
`isTreehouseAccount` (matches `isOrgAccount`); update copy
([my-household/page.tsx:331](../../src/app/my-household/page.tsx#L331),
[api/household/route.ts:53](../../src/app/api/household/route.ts#L53)) and the
`STAFF_ENTERED` value on `TrustedAdultOrigin`. **Not** the privileged-viewer sense
(that's Admin, above). _(VOCAB #7)_

---

## 🟢 Make `ToolLevel` rank explicit

Enum declares `BASIC, DOF, CERTIFIED, INSTRUCTOR, MAY_CERTIFY_OTHERS` but real rank
is `BASIC < CERTIFIED < DOF < INSTRUCTOR < MAY_CERTIFY_OTHERS`. Reorder (or add an
ordinal) so declaration order = rank; only `LEGEND_LEVELS` carries the truth today.
_(VOCAB #2)_

---

## 🟢 "Tool Certifier" vs "Shop Certifier" label

Code uses both; policy canonical = **Tool Certifier**. One user-visible "Shop
Certifier" label left ([ToolLevelBadge.tsx:22](../../src/components/ToolLevelBadge.tsx#L22),
plus its doc comment `:32`); `RoleBadge.tsx` and `security/core.ts` already say
"certifier" (two prose comments in core.ts still read "shop certifier").
_(VOCAB #2)_

---

## 🟢 Name the relief types: Payment Plan / Scholarship

Distinct from a **manual payment** (already renamed — `via: "manual"` /
`manualPaymentById`): **Payment Plan** (installments,
`isPaymentPlanRequested`) and **Scholarship** (board comp, 0 code refs today)
— one process handles either/both. The relief surfaces still say "certify":
`certifyPaymentPlan()`
([payment.ts:249](../../src/lib/membership/payment.ts#L249)), the route path
`/api/membership-ops/applications/certify-payment`, and the
`certificationNote` column, which now holds the note for BOTH a manual payment
and a payment-plan approval. _(VOCAB #17)_

---

## 🟢 Drop the vocabulary-rename `@map` shims (contract stage)

"dues" → "membership fee" (`BoardSettings.standardMembershipFeeCents`,
`.volunteerMembershipFeeCents`) and "certified" → "manual"
(`OrgMembershipProcess.manualPaymentById`) shipped the Prisma/API/UI half; all
three fields still `@map` to the old physical columns, which a rolling deploy
can't rename in the same release. Rename them once that release is out —
[#1583](https://github.com/innovationtreehouse/checkin/issues/1583).
_(VOCAB #6, #17)_

---

## 🟢 Retire `dependent` + fix intake `children` bucket (BUG-2)

"dependent" is UI jargon for a **non-lead** household member — resolve to "household member".
- **BUG-2:** `lib/membership/intake.ts` `children` bucket = *every non-lead* (not
  offspring/age); it's the `children` wire key on `GET /api/membership` (`:131`) +
  `POST /api/membership/intake` (`:304`), consumed by `membership/page.tsx`
  (`prefill.children`, `buildPayload().children`). Rename key + type
  (`ChildInput` → `HouseholdParticipantInput`, `children` → `householdParticipants`/`dependents`)
  across server + client + page in one commit. **NOT `youth`** — it's a non-lead concept.
- **Copy:** `communication/page.tsx:11` label, `my-household:443`,
  `membership-ops/participants/import:138`, `trusted-adults:12`, `pageRegistry:26,66`,
  `api/programs/[id]/participants:64`, `notifications.ts:86` → "household member".
- **Persisted key:** `emailDependentCheckins` is a `notificationSettings` **JSON key**
  (not a column) → `emailHouseholdCheckins` in readers/writers
  (`notifications.ts:150`, `communication/page.tsx:27,41`, tests
  `notificationsCheckin.integration.test.ts:43,61` + `.perf.test.ts:28`). DB wiped → no backfill.
_(was proposal Phase 6)_

---

## 🟡 The `'member'` field-visibility TIER — left unrenamed by Phase 4 (decide if it ever should be)

Phase 4 renamed the org-membership **model/relationship** (`Membership` →
`OrgMembership`, price fields → `orgMember*`, `/api/shop/org-members`, "Treehouse
Member" copy — shipped #729/#731/#732/#735). It **deliberately did NOT touch** the
separate `'member'` **security field-visibility tier**, which is a different axis
(a typed access contract, not the membership noun):

- `Tier = 'public' | 'member' | SensitiveTier | 'secret'` and
  `Token = 'public' | 'member' | …` ([security/core.ts:55,74](../../src/security/core.ts#L55)).
  Semantics: a `member`-tier field is visible to a member view; a member view holds
  BOTH `'member'` and `'public'`, anon holds only `'public'`.
- Surface if ever renamed to `'orgMember'`: ~43 `'member'` tokens across
  [registry.ts](../../src/security/registry.ts) scope arrays; the one
  `@sensitivity:member` schema tag ([schema.prisma:254](../../prisma/schema.prisma#L254),
  on `ToolStatus`); `level: 'member'` in generated
  [classifications.ts](../../src/security/generated/classifications.ts); parser
  guards ([scopes.ts:260](../../src/security/scopes.ts#L260), core.ts).

**Why deferred:** it's a security contract, **partly tsc-blind** (bare string
literals in scope arrays + `@sensitivity:` comment) — a rename needs the full jest
security suite (registry/strip/scope oracles) as the net, and carries real
over/under-grant risk if botched. Its own slice if done.

**Open question (🟡):** is a rename even wanted? `'member'` as a *visibility* tier
reads fine ("member-visible") and isn't the org-membership noun — it may
legitimately stay forever. Decide: rename to `orgMember` for dictionary purity, or
bless it as-is and record that in VOCABULARY. _(Phase 4 OQ-1)_

---

## 🔵 Aspirational — not built yet (enforced by policy / no data today)

- **Corporation / Organizational Partner Member** — no corporate partners today.
  Keep `Corporation`/`CorporationLead`/`CorporationMember` as scaffolding; when
  built, define the concept and qualify the bare `CorporationMember`. _(VOCAB #5)_

---

# Architecture / auth end-state — from the 2026-06-29 codebase audit

Provenance: a 2026-06-29 codebase architecture audit (recorded in git history; the
auth end-state detail lives in
[auth-consistency-analysis.md](../../../docs/security/auth-consistency-analysis.md)), distinct
from the vocabulary sweep above. **Everything else that audit flagged has
shipped** — the P0-B auth-consolidation buckets, the P1 near-neighbor fixes, P3-1
error-path (`apiError` + lint, #728), P3-2 logger (#727), P1-2/6/7/8, P2-1 Person
rename, P2-2 counterparty→trustedAdult (#734), and the GAP-1 program-roster leak.
Two remain here; the 3-tier restructure and the GAP-2 drift-guard have graduated to
issues (see *Tracked as issues* below).

## 🔵 `handler()` consolidation — the "one authorization rule" end-state

~13 of ~144 routes use the security `handler()` runtime; ~118 use `withAuth` (admission
only, no field stripping) with row-authorization hand-rolled inline. End-state:
`handler()` becomes the default, `withAuth` collapses into a degenerate `handler()`
(permissive `orderedView` → no-op stripper), `withCron`/`withWebhook`/`withKiosk` stay
the non-session front doors, `authenticateRequest` goes internal-only. This is
**consolidation, not a security gap** — sequence behind everything else.
Ref: [auth-consistency-analysis.md](../../../docs/security/auth-consistency-analysis.md) §4, §9 Steps 5–6.

## 🟢 Response envelope — phase 2 (success bodies)

Error responses route through `apiError()` + a lint guard (#728). **Success** bodies are
still ad-hoc (~252 raw `NextResponse.json`, varied shapes: `{data}`, `{household}`,
`{Person}`, …). Standardizing them is deliberately deferred to **ride the `handler()`
migration** (handler owns the success `envelope`), not a parallel rewrite. Ref: P3-1.

---

## Tracked as issues — removed from this ledger (do not re-add)

These were surfaced here, then graduated to the issue tracker. The issue is the
live record; this doc no longer carries them.

- **Program → Instance → Event, 3-tier restructure** — **#1361** (phase 1: additive
  tier + backfill). Design: [PROGRAM_INSTANCE_RESTRUCTURE.md](../../../docs/designs/PROGRAM_INSTANCE_RESTRUCTURE.md).
  Related: #1243 (volunteer↔instance assignment).
- **GAP-2 drift-guard CI ban** (fail on new `getServerSession` / unregistered prisma
  route) — **#1320**. Ref: [auth-consistency-analysis.md](../../../docs/security/auth-consistency-analysis.md) §9 Step 7.
- **Tool categories not modelled** — **#1440**.
- **Per-level / per-category age gates** (10/13/21) — **#1439**.

The vocab renames still listed above are the body of the umbrella issue **#1322**
(*Vocab rename ledger (UNFINISHED.md)*), which points back at this doc — so they stay
here rather than graduating.

---

## Considered and dismissed (no drift — recorded so we don't re-audit)

- **RSVP** — `RSVP` / `RSVPStatus`; distinct from Visit (intent vs actual);
  consistent. (One-line dictionary note only: RSVP=intent, Visit=actual.)
- **BoardSettings vs AppSettings** — split documented inline in schema
  (money/membership policy vs deployment tz/locale). Clean.
- **EmergencyContact** — clear, well-commented; not-a-household-member invariant
  documented. (`conflictParticipantId` is Person-migration tail, not new.)
- **Audit / Error / Metric / Integration / Dev logs** — internal, self-describing.
- **Account / Session / VerificationToken** — standard NextAuth. The remaining
  smell is the `userId Int @map("participant_id")` on `Account`/`Session`
  ([schema.prisma:1189](../../prisma/schema.prisma#L1189), `:1222`) — a
  Participant-era physical column NextAuth insists on calling "user". Left
  alone: renaming it is a migration, not a vocab fix.
- **AttestationResult / OrgMembershipStatus / ProgramPhase / EnrollmentStatus** —
  well-scoped status enums; no cross-layer drift. (Was `MembershipStatus`; renamed
  with the model in Phase 4 #735.)
- **`membership-ops/*` + `membership-audit/*` route/dir/nav paths — kept, not
  Org-prefixed (Phase 4 OQ-7).** Phase 4 Org-prefixed the model, price fields, shop
  path, and user copy but left these admin **ops-surface** paths as `membership-ops`
  / `membership-audit` (the model/prisma references *inside* those files did rename).
  Deliberate — renaming the dirs/routes/nav would cascade into `pageRegistry`, nav
  tests, and every internal `router.push`, for no user-visible gain. Recorded so
  nobody re-audits it as leftover drift.
- **Attendance "volunteer" / "youth" buckets** — `getFullAttendance` +
  `attendance/current` bucket live visitors by age + keyholder flag
  (`volunteer` = adult non-keyholder, `youth` = minor), NOT by real
  `ProgramVolunteer` / enrollment. **Won't-change:** it's the intended
  "adults-on-the-floor vs youth" **supervision** signal (already labelled
  "Volunteers/Adults" in the UI), and that age split is **safety-load-bearing** —
  the two-deep / unaccompanied-youth banner depends on `adult = !isYouth`. Do NOT
  "enrollment-ify" these buckets. (The separate `facility/trends` age-proxy
  *metric* WAS a real bug and was fixed independently.)
- **Security handler `{ Model: rows }` bag key vs `envelope`** — a stripper route
  returns its rows keyed by the **model name** (that drives field-tier stripping in
  `security/handler.ts`), then re-wraps under the route's `envelope` for the wire
  (e.g. `/api/shop/org-members` → `{ org-members: [...] }`). The bag key reading
  differently from the wire key is **intentional**, not a mismatch — do not "fix" it.
- **Certifier "any-tool → global" widening — ACCEPTED (2026-07-02), not a security
  issue.** Certifiers are a small group; the `isCertifier` nav/access checks that
  fire on holding `MAY_CERTIFY_OTHERS` on **any** tool (`shopNav`,
  `access-resolvers`, `pageRegistry`, `AppFrame`, `ToolManagementPanel`) are
  intended convenience, not an over-grant. The **grant action itself stays
  per-tool** ([shop/certifications/route.ts](../../src/app/api/shop/certifications/route.ts)) —
  you can only certify others on a tool you're a certifier for. No change needed.
- **`household` vs `family` — split kept, decided.** Code is `Household`; "family"
  is allowed as warm user copy, and `TrustedAdult.familyContext` is a distinct
  *attribute* (the board-facing explanation), not a stale alias — both recorded in
  [VOCABULARY.md](../VOCABULARY.md). The unify option (`familyContext` →
  `householdContext`, `memberFamilies` → `memberHouseholds`) is **not** being taken.
  _(was proposal Phase 5)_
- **`student` / `youth` == non-lead** — checked, **NOT** a logic conflation. It
  lives only in vocabulary (`dependent` ≈ non-lead; old `student` ≈ minor);
  promotion allows a non-lead **adult** → lead (`my-household`). Behavior preserves
  the distinction. Recorded so nobody re-audits it as a bug.
