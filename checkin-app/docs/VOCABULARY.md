# Canonical Vocabulary

The one place that defines what each domain word means in this codebase — people,
roles, money, tools, attendance, entities. It is built on **relationships, not
loose nouns**: a person is named by *which relationship you are viewing them
through*. The same human legitimately carries several names at once — a kid is a
**household member** on the household screen and a **participant** on a program
screen. That is not a collision to "fix"; it is the model working as intended.

Terms are **product-owner decided**. Where the code hasn't caught up yet an entry
is marked *(rename pending)* and tracked in the followup ledger,
[designs/UNFINISHED.md](designs/UNFINISHED.md).

## The core rule

**Never a bare `member` / `Member` / `Membership` — in code OR UI.** It is always
qualified by the relationship's target: **Org** or **Household**. A screen or
identifier that just says "member" is a bug against this dictionary.

## The relationships

| Concept | Relationship | UI word | Code identifier | Model / table | Path |
|---|---|---|---|---|---|
| **Person** | the human (any human: volunteer, youth, lead, enrollee) | name / "person" | `person` | **`Person`** (the umbrella person model) | — |
| **Org Membership (A)** | Person/household ↔ **Organization** | **"Treehouse Member"** | `isActiveOrgMember`, `orgMember…` | `OrgMembership` | `/api/shop/org-members` |
| **Household** | grouping of people | "household" (warm: "family") | `household` | `Household` | `/api/household` |
| **Household Membership (B)** | Person ↔ **Household** | "household member" | `householdMember` | `householdId` FK + `Person.isHouseholdLead` (lead variant) | `/api/household/member` |
| **Program relationship** | Person ↔ **Program** | **"participant"** | `programParticipant` | `ProgramParticipant` | — |

Rules (the no-bare-member rule above applies throughout):
1. **`participant` means ONLY a program enrollee** (`ProgramParticipant` / the Program relationship). It is NOT the person model and NOT a generic word for "any person." The umbrella person model is **`Person`**. **Admin and volunteers are never "participants."**
2. **Anything showing MIXED people uses the umbrella, not "participant."** A screen or API listing volunteers/youth/leads together is `Person`/"person"/"people", or an explicit role bucket — never "participants".
3. **A person carries multiple relationship-names at once.** Same human, different relationship on different screens (household member here, program participant there, Treehouse Member elsewhere). Do not "reconcile" these into one word.
4. **The `/api/household/member` route stays put.** The `/household/` path segment already qualifies "member" as the household relationship — do NOT move it to `/participant`.
5. **`participantProjection.ts` / `HOUSEHOLD_PEER_SELECT` project a Person row** — the enrollee sense they are NOT; they rename *with* the model (→ person projection).

## People — sub-classifications

*What kind of person*, independent of which relationship you're viewing:

| Term | Meaning | Code | Copy |
|---|---|---|---|
| **Adult** | 18 or older (policy); normally derived from `dateOfBirth` | — | "adult" |
| **Declared Adult** | self-asserted **"25+"** with **no DoB captured** (PII minimization) — a valid subset of Adult. 25 (not 18) = the age past which no program-run restriction applies (Close-in-Age safe line) | `isDeclaredAdult` | — |
| **Youth** | under 18 — an **age** classification (`isYouth(dob)`). Absorbs the age-synonym **minor** only | `youth` / `isYouth` | "youth" |
| **Child** | the lead's **offspring / kin** — a **relationship**, age-independent (a 25-year-old is still their parents' child). Distinct from `youth` (age) and `dependent` (non-lead) | `child` | "child" / "children" |
| **Student** | a **pre-college program enrollee** — derived from `ProgramParticipant`, **NOT an age test** | `student` (enrollment contexts only) | "student" only where truly an enrollee |
| **Dependent** | a **non-lead** household member a lead acts for; broader than `child` (a non-lead adult non-offspring is a dependent, not a child) | non-lead subset of `householdMember` | "someone in your household" |
| **Visitor** | a person who is **not a Member** (a non-member at a Location/Event) | scope `all_current_visitors` | "visitor" |

**`Visitor` vs `Visit`** — a **non-member person** vs an **attendance record**; they share a root but are unrelated. Accepted near-collision — no rename, just know the difference.

## Volunteer & program roles

**Never a bare `volunteer`** — the word is one umbrella over three distinct children. And **the Treehouse is 100% volunteer: there is no "staff."**

| Concept | Meaning | Code | UI |
|---|---|---|---|
| **Treehouse Volunteer** | umbrella: a BG-checked, board-approved adult who volunteers — **program-optional** (a bookkeeper is one, with no program) | — | "volunteer" |
| **Volunteer Family** | a Member Family with **no youth/student enrolled**, whose adults volunteer → **reduced membership fee** | `OrgMembership.isVolunteer` (rate) + `VolunteerDesignation` (email pre-auth) — **one concept** | "Volunteer-only family" |
| **Program Volunteer** | a Treehouse Volunteer assigned to a **specific program** | `ProgramVolunteer` (`isCore` → **Core Volunteer**) | "Volunteer" / "Core Volunteer" |
| **(attendance) volunteer bucket** | courtesy label for present adults — **not a role**; deliberately loose, UI-safe | derived in attendance | "Volunteers/Adults" |

Program roles (all Treehouse Volunteers):

| Role | Meaning | Code | Notes |
|---|---|---|---|
| **Program Leader** | the person responsible for a program | `programLeaderId` *(rename pending from `leadMentorId`)* | policy term; **retire "lead mentor"** |
| **Program Volunteer** | program helper; **Core Volunteer** = the authorized subset who can run it | `ProgramVolunteer.isCore` | Core's legal-authority rules are organizational (out of software scope) |
| **Program Treasurer** | a Program Volunteer who keeps the program's money; a program may have several. With the Program Leader, approves within the program's budget-owner bucket | `ProgramVolunteer.isTreasurer` | policy term (*Sponsored Program Policy, Art. III §III.7*) |

**Retired words (do not use):** `staff` / "program staff" (→ Treehouse Volunteers), `mentor` and `lead mentor` (→ Program Leader / Program Volunteer; program-specific "mentor" language is external), "program instructor" (→ `instructor` is **tool-only**, see Shop & Certification).

## Roles & accounts

- **Keyholder** (`isKeyholder`) — a **board-anointed policy role**: a Member who can open a Treehouse Facility; carries facility-rules/emergency responsibility. A standing role, not a presence status (attendance code merely reads it).
- **Board Member** (`isBoardMember`) — a governance role; **distinct from the OrgMembership "Treehouse Member"** (a Board Member need not be a Treehouse Member). Not the bare-`member` this dictionary bans.
- **Treehouse Account** — an internal org-domain (`@innovationtreehouse.org`) account; not a real Member Family. `isTreehouseAccount` *(rename pending from `isStaffAccount`; also `STAFF_ENTERED`)*.
- **Admin** — ⚠️ **UNRESOLVED / do not rely on.** "admin" is a loose derived label (no `isAdmin` column) that means `isSysadmin` in some files and `isSysadmin || isBoardMember` in others. Security-sensitive; deferred to its own discussion (UNFINISHED.md).
- **Review / Reviewer** — the BG-reviewer role, the membership review queue, and `BackgroundCheckAttestation.reviewer` are **one concept**, defined under [Background check](#background-check). Trusted-adult review keeps its own **review** + **decider** (`TrustedAdultReview.decidedBy`) — one board member's decision with recorded reasoning, not a two-of-N attestation. **Scholarship Review Team** (see Money) is a third, unrelated.

## Shop & Certification

`Tool` = the **equipment**. A person's competency **on** a tool is their **certification level** (`ToolStatus`); the rungs are the **certification levels** (`ToolLevel`; policy word: "tool rating"). Color and word **align intentionally** (the dot-color UI view bridges them) — interchangeable, record both:

| Rank | Color | Enum (`ToolLevel`) | Label | Meaning | Min age |
|---|---|---|---|---|---|
| 0 | No Dot | *(no `ToolStatus`)* | "Uncertified" | hasn't used the tool here | — |
| 1 | Red | `BASIC` | "Basic" | knows basic safety | 10 |
| 2 | Green | `CERTIFIED` | "Certified" | safe & successful; solo only with a **Tripod** | category-based |
| 3 | Yellow | `DOF` | "DOF" | **Defender of the Finger** — keeps their head when things go wrong | 13 |
| 4 | Blue | `INSTRUCTOR` | "Instructor" | can teach others | 13 |
| 5 | — | `MAY_CERTIFY_OTHERS` | **"Tool Certifier"** | board-appointed; can change a user's certification level | 21 |

Rules:
- **Canonical top label = "Tool Certifier"** *(retire "Shop Certifier")*.
- **`instructor` is tool-only** — "program instructor" is banned.
- **Enum rank ≠ declaration order** — real rank is `BASIC < CERTIFIED < DOF < INSTRUCTOR < MAY_CERTIFY_OTHERS`; make it explicit in the enum *(pending)*.
- **Tool Certifier is per-tool for *granting*** (you may only certify others on a tool you certify); treated as a global flag for *nav/visibility* only — accepted (small group).
- **Age gates + tool categories are policy-enforced outside the software** today (aspirational to model).

## Money

**The canonical money word is `fee`.** Kinds: **membership fee** (`BoardSettings.standardMembershipFeeCents`, `BoardSettings.volunteerMembershipFeeCents`), **program fee** (`Program.orgMemberPriceCents` / `nonOrgMemberPriceCents`), plus **shop fee** and **facility fee** (shop and facility are billed separately). `price` = the cents **amount** on a fee, not a rival concept. There is no `Fee`/`FeePayment` model: program payment truth lives in the Shopify pipeline (`ProgramParticipant.status` + `shopifyOrderId`, `shopify_read`, `PaymentException`); the dead `Fee`/`FeePayment` tables were killed in FR7 (#354).

**Payment vs relief** (keep separate):
- **Manual payment** — payment landed **outside Shopify** (recorded in QuickBooks), so a membership activates without a Shopify order. `via: "manual"` / `manualPaymentById`. **Not** a comp.
- **Payment Plan** — installments (`isPaymentPlanRequested`).
- **Scholarship** — a board comp (fee waived). Unnamed in code today.
- **Scholarship Review Team** — the board-designated recipients of scholarship / payment-plan
  request notifications (`BoardSettings.scholarshipNotifyEmail`; falls back to all board members
  when unset). The canonical UI/copy term — **retire "Finance Committee"** for this concept.

## Background check

One flow, three acts to keep apart. **Reviewing is the job; attesting is the act
that ends it; a clearance is what two attestations produce.**

**review** (read the report on Averity) → **attest** (one reviewer's judgement of one
adult) → two attestations → **clearance** (dated; the validity window runs from it).

| Term | Meaning | Code | UI |
|---|---|---|---|
| **Reviewer** | the person — a background-check reviewer, or a board member (implicitly one). The role and the job, not the act | `isBackgroundCheckReviewer` / `BG_REVIEWER` | "reviewer" |
| **Review** | the **reading** of the Averity report. Not the decision | `/membership-ops/review`, `/api/membership/reviews` | "review" |
| **Attest** | one reviewer putting their name to a judgement about one adult — the act, and the only thing the app stores | `attest()`, `BackgroundCheckAttestation` | "Attest" |
| **Approve / Reject** | the **value** carried on an attestation — what was judged, never the act of judging | `AttestationResult` | "Approve" / "Reject" |
| **Clearance** / **cleared** | the outcome: two attestations, dated. The re-check window runs from that date | `bgClearedAt`, `PENDING_BG_CLEARANCE`, `Person.lastBackgroundCheck` | "cleared" |
| **Consent** | the **applicant's** act — they submitted the Averity form. Never "attest" | `bgConsentAt`, `markBgConsent` | "consent" |
| **Override** | the board acting against the flow's own outcome — force-approving a blocked application, or discarding attestations | `overrideBlocked` | "override" |

Rules:
1. **A reviewer attests; two attestations clear the check.** One word per sense —
   never "approve" for the act, never "attest" for the outcome.
2. **Never "clean," never "passed."** The app never holds the report or its
   result, only that a reviewer read it and what they judged
   ([../../docs/rules/membership.md](../../docs/rules/membership.md), Procedure ›
   Application and review). Both words state an outcome of the report; "I approve
   this person" states the judgement, which is what is stored. Policy's own
   outcome vocabulary is approval, restriction, or denial — a pass/fail framing
   has nowhere to put the middle one.
3. **`clear` never means erase.** Undoing attestations is **discard**. Erasing a
   person's clearance date is **remove**. `clear` is reserved for the outcome
   above — and as a **verb on a button** it reads as *reset* even so, which is why
   the reviewer queue names the outcome with the noun (*complete the clearance*),
   not the verb.
4. **"Attest" is the reviewer's word alone.** An applicant **consents**; a Tool
   Certifier **certifies** (see Shop & Certification).
5. **`PENDING_BG_REVIEW` and `PENDING_BG_CLEARANCE` do not mark review vs
   clearance** — they differ by whether dues are paid. A known misnomer; the enum
   stays, because renaming a status reaches the schema, a migration, and the
   applicant-facing wire.

## Attendance / check-in

One activity, a pipeline of distinct stages — name each; keep the scoped verbs:

**scan** (badge tap at a **kiosk**) → **`RawBadgeLog`** (raw event) → **`Visit`** (the attendance record; `VisitSource`) → **attendance** (the rollup view).

**"check-in" / "check-out"** = the **action**; **"attendance"** = the **view**; `Visit` = the internal record. Both "check-in" and "attendance" are canonical in their own scope — do not collapse.

## Shop vs Facility (distinct billable domains — not a collision)

- **Shop** = the makerspace: tools, certifications, shop safety; billed separately.
- **Facility** = the building / attendance / access domain; billed separately.
- Intentionally distinct (separate billing + the shop's own safety rules). The only real overlap to disambiguate: **Shopify** also uses "shop".

## Supervision terms (safety vocabulary)

- **Tripod** — the presence of **3 Members, each ≥ 9 years old**, in an area that is **Observable and Interruptible**; lets a Certified (Green) work solo. *(policy term; not modeled in code)*
- **Two Deep** — two unrelated, non-Student adult Treehouse Volunteers from different households. *(the attendance keyholder/volunteer buckets implement this)*
- **Observable and Interruptible** — no locked doors; another adult can see or hear and could enter. *(not modeled)*
- **"dedicated" (DOF/Instructor)** — "actively watching you use the tool" (not wandering). **Not software-enforceable — ignore in code.**

## Named entities (not a person, but carry multi-layer names)

### Trusted Adult

`model TrustedAdult` is an **authorization record**, NOT a person. It involves two people:

- **`disclosedBy`** — the **subject**: the Person who entered the disclosure.
- **`trustedAdult*`** — the **adult being trusted**: `trustedAdultName` / `trustedAdultPhone` / `trustedAdultEmail`, plus an optional Person link `trustedAdultPerson` / `trustedAdultPersonId`. Historically called the **"counterparty"** — that word now survives **only in explanatory prose**, never as an identifier.

Synonyms for the SAME concept across layers:

| Layer | Name |
|---|---|
| Model / DB / relations | `TrustedAdult` (the record) |
| Adult's fields on the record | `trustedAdult*` |
| Policy prose | "dual relationship" |
| Member / board UI label | **"Trusted Adult"** |
| Operational (front-desk) UI label | **"Pickup"** |

**NOT synonyms:** **"guardian" / "guardianship"** (a household lead/parent, or a relationship *type* — never this entity); **`familyContext`** (a distinct *attribute* of the record — the board-facing explanation — not another name for it). The schema carries this same glossary inline above `model TrustedAdult`.

### Emergency Contact vs Trusted Adult

Both are non-household people attached to a household, and **may be the same person, but the sets are not identical — do not merge.** Emergency Contact (`EmergencyContact`) = **who we call in a bad situation**; Trusted Adult (`TrustedAdult`, UI "Pickup") = **who may pick up / transport / be alone with a child.**

### Membership application

**`OrgMembershipProcess` = the membership "application"** — technically an intake process, called an **"application"** because it includes a background check (vendor **Averity**) and **can be rejected**. One `OrgMembershipProcess` = one cycle (`INITIAL` or `RENEWAL`); `INTAKE` is its first stage.

### Corporation (aspirational)

`Corporation` / `CorporationLead` / `CorporationMember` — scaffolding for the policy's **Organizational Partner Member** (partner orgs running programs). No corporate partners today; keep as-is, and qualify the bare `CorporationMember` when it's built.

## Program hierarchy (LOCKED)

Product-owner decision — **design to these; do not relitigate the names or shape.**

**Program → Instance → Event** = **definition → offering → occurrence.**

| Level | Semantics | Meaning | Code | UI |
|---|---|---|---|---|
| **Program** | definition | a **reusable definition / template** — a catalog entry (e.g. "Woodworking 101") | `Program` | "Program" |
| **Instance** | offering | one **concrete offering / run** (e.g. "Fall 2026 Woodworking") | **`ProgramInstance`** — **never** bare `instance` / `instanceId` (too generic) | "Instance" |
| **Event** | occurrence | a **dated occurrence / meeting** people check into | `Event` (today's `Event` row **is** this leaf — it stays the leaf) | "Event" |

`Event` is unchanged — the Instance layer is inserted **above** it, not in its place.

## Reference facts

- **Membership Year** = **Sept 1 – Aug 31** (policy); `membershipYearBoundary` stays configurable by design.
- **Single facility** — check-in happens only at the one Treehouse Facility; multi-location is not on the roadmap (`RawBadgeLog.location` free-text is fine).
- **Integration vendors** — **Averity** (background check; aka "VERITY"), **Zoho** (e-sign), **Shopify** (payment).
- **Treehouse Card** — any corporate/business/debit/credit card opened on the Treehouse EIN (reserved for future financial rules).

## Coding conventions

- **Code identifiers AND comments/prose** use the canonical word. No `minor`, no loose `dependent`, no bare sense-B `member`, in identifiers *or* comments. **`child` is allowed** — a valid relationship term (offspring); use `youth` only for the under-18 age.
- **API wire keys are a contract**, not a free rename. A serialized request/response key changes only in the change that owns that contract, all consumers moved together. Rename surrounding vars freely; leave the key until then.
- **Age is always derived from `dateOfBirth` via `isYouth`** — never re-implement an age check inline.

## Migration status

The core term-by-term migration (person / member / participant / youth / OrgMembership) is **complete and shipped**. What's left is the followup ledger — the renames the *(rename pending)* entries above imply, plus open decisions — in [designs/UNFINISHED.md](designs/UNFINISHED.md).

> **Pattern for big Prisma model renames** (learned from `Participant`→`Person`): a model rename is *atomic* — tsc is red until every accessor/type flips, so it can't merge half-done. Pull everything NOT tied to the model name (local types, then per-model FK renames — Prisma allows `person Participant @relation(fields:[personId])`) into small green PRs first, leaving a final purely-mechanical name flip. See git history #680–#708 (Person) and #735 (OrgMembership).

The shipped-vs-pending status of each term is the dictionary itself: an entry with no *(rename pending)* tag is done. The remaining followups, and the decisions deliberately **not** taken (e.g. the attendance volunteer/youth buckets stay age-derived, not enrollment-derived), live in [designs/UNFINISHED.md](designs/UNFINISHED.md).
