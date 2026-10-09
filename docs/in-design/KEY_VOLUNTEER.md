# Key Volunteer designation

## Problem

The organisation requires certain volunteers to sign an elevated agreement — the
Key Volunteer Agreement (KVA) — beyond the standard membership agreement. Policy
names two groups explicitly: every background-check reviewer
(*Membership Policy, Art. VI §VI.2*) and every board member
(*Membership Policy, Art. VI §VI.2*; `docs/rules/membership.md` assumption).

In practice, the same obligation extends to anyone carrying risk beyond the base
membership agreement — credit-card holders, complex-procurement participants,
people with access to donor PII.

The app does not know this agreement exists. Board and reviewer role grants
assume the person has already signed it, with no record and no trigger. The
assumption holds today because the population is small and personally known, but
it is invisible: a new board member's unsigned KVA is chased by memory, not by a
list.

## Objective

When someone is designated a Key Volunteer — whether automatically by their role
or explicitly by the board — the app surfaces the obligation and tracks its
settlement. The designation is visible; the agreement's signing status is
visible; and a list of outstanding obligations exists for the board to work.

## Executive summary

- **For board members and BG reviewers:** their role grant opens a KVA
  obligation automatically. They sign it through the same Zoho Sign /
  mock-signing flow the membership agreement uses.
- **For other Key Volunteers** (cardholders, procurement participants, etc.):
  the board designates them explicitly, which opens the same obligation.
- **For the board:** a queue of unsigned KVAs, alongside the existing BG-review
  and intake-note queues.
- **What deliberately does not change:** the KVA does not gate role exercise.
  A board member who has not yet signed can still act as board. The obligation
  is chased, not enforced — same posture as the individual membership agreement
  (`PERSON_AGREEMENT`).
- **What this does not build:** the KVA document itself, procurement-tier
  enforcement, or credit-card-holder tracking. Those are separate concerns
  (GC-FIN-CONTROL, external systems). This builds the designation and the
  signing obligation it triggers.

---

## Standing rules this relies on

- Every reviewer has signed the key volunteer agreement.
  — *Membership Policy, Art. VI §VI.2* (`docs/rules/membership.md` line 88)
- Every board member has signed the key volunteer agreement and is a designated
  background-check reviewer.
  — `docs/rules/membership.md` assumption (line 145)

## Standing rules this would change

The current assumption in `docs/rules/membership.md`:

> Every board member has signed the key volunteer agreement and is a designated
> background-check reviewer. Board membership alone therefore qualifies someone
> wherever a reviewer is required.

**Replacement:** the first sentence moves from assumption to procedure — the app
tracks it. The second sentence (board = qualified reviewer) is unaffected.

---

## Design

### What is a Key Volunteer

A Key Volunteer is a person who carries risk beyond the base membership
agreement and is therefore required to sign the KVA. The designation is a
**union** of two sources:

1. **Automatic** — holding a BOARD or BG_REVIEWER PersonRole. Granting the role
   makes the person a Key Volunteer; revoking it does not retroactively remove
   the designation (a signed KVA is a fact about the past, not about the current
   role).

2. **Explicit** — a board member or sysadmin designates someone as a Key
   Volunteer for reasons not captured by a role (cardholder, procurement
   participant, donor-PII access). The reason is free text — there is no
   picklist of Key Volunteer subtypes.

A person can be both automatic and explicit. The KVA obligation is one
regardless of how many sources feed it.

### The obligation

When someone becomes a Key Volunteer and does not hold a current KVA signature:

- A `KEY_VOLUNTEER_AGREEMENT` process opens on `OrgMembershipProcess`, using the
  existing per-person process shape (`orgMembershipId` null, `subjectPersonId`
  set — same as `PERSON_BG` and `PERSON_AGREEMENT`).
- The process starts at `PENDING_EXTERNAL_ACTION` and settles on signature, same
  flow as `PERSON_AGREEMENT`.
- Signing routes through Zoho Sign (or the mock-signing interstitial in dev),
  using the KVA document template instead of the membership agreement template.

### Annual cycle

The KVA is signed once per membership year, like the household membership
agreement. The annual renewal sweep opens a new `KEY_VOLUNTEER_AGREEMENT`
process for every active Key Volunteer whose current-year KVA is not yet signed.

The dedup floor is the membership-year boundary, same as `PERSON_AGREEMENT`: a
KVA signed at or after the current boundary covers the current year.

### Triggers

| Event | Action |
|-------|--------|
| BOARD or BG_REVIEWER role granted | If no current KVA, open one |
| Board explicitly designates someone | If no current KVA, open one |
| Annual renewal sweep | Open for every active Key Volunteer without a current KVA |
| BOARD and BG_REVIEWER both revoked, no explicit designation | No new obligation opens; existing signed KVAs stay |

### What it does not gate

- Role exercise: a board member without a signed KVA can still act as board.
- BG review: a reviewer without a signed KVA can still review.
- Check-in, program participation, membership — none affected.

The unsigned KVA is a compliance gap, surfaced on the board's queue. The board
chases it. The same posture as the individual membership agreement, and for the
same reason: blocking a board member from acting until they sign defeats the
purpose of having them on the board.

### Data model

**New enum value:** `KEY_VOLUNTEER_AGREEMENT` on `OrgMembershipProcessKind`.

**Explicit designation storage — two options:**

**Option A: KeyVolunteerDesignation table** (parallel to `VolunteerDesignation`).
A separate table with `personId`, `designatedById`, `designatedAt`, `reason`,
`revokedAt`. Explicit designation is a first-class record with audit trail.

**Option B: PersonRole with a new kind** — add `KEY_VOLUNTEER` to
`PersonRoleKind`. Simpler (reuses existing role machinery), but Key Volunteer is
not an RBAC capability — it carries no session flag, no JWT claim, no
`withAuth` gate. Adding it to `PersonRoleKind` conflates a designation with a
capability role.

**Recommendation: Option A.** The Key Volunteer designation is not a capability
grant. It is a record that someone carries elevated risk and owes a contract.
Mixing it into the role table muddies the role table's meaning (every other kind
gates something). A small table with clear semantics is cheaper than explaining
why one PersonRoleKind doesn't work like the others.

### Board UI

- **Queue:** "Key Volunteer Agreements" alongside "Background Checks" and
  "Intake Notes" in the board's membership-ops navigation. Shows people with an
  open (unsigned) KVA process. Count in the nav badge.
- **Designation:** on the person detail page, a "Key Volunteer" section showing
  whether they are designated (automatic, explicit, or both), and the current
  KVA status. Board/sysadmin can add or revoke an explicit designation here.
- **Compliance view:** a row per Key Volunteer showing KVA status, last signed
  date, and source (role / explicit / both).

### Signing flow

Reuses the existing Zoho Sign integration path:

1. Person clicks "Sign Key Volunteer Agreement" (on their dashboard or from the
   board queue).
2. App sends the KVA template to Zoho Sign (or the mock interstitial in dev).
3. Zoho callback (or mock completion) flips the process to `ACTIVE`.
4. The signed envelope ID is stored on the process (`zohoEnvelopeId`,
   `zohoActionId`), same as membership agreements.

The KVA template is a new Zoho Sign template, configured in BoardSettings
alongside the existing membership-agreement template reference. If no template
is configured, the signing action is unavailable and the queue shows "template
not configured" — the board can still designate people, but the signing flow is
blocked on setup.

---

## Open questions

1. **Does the KVA gate role exercise?** This design says no — chased, not
   enforced. If policy tightens to require a signed KVA before someone can act
   as a reviewer, the gate is a one-line check on the review submission path.
   Confirm with owner.

2. **Is the KVA really annual?** The membership agreement is annual because
   policy says "separately for each membership year." The KVA's renewal cadence
   is not stated in the 13 policies. If it's once-ever rather than annual, drop
   the renewal-sweep trigger and simplify.

3. **Should revoking all roles + explicit designation close an open KVA?** This
   design keeps it open (the person still owes the signature for the period they
   held the role). Alternative: archive the process, same as an abandoned
   membership application.

4. **Is the Zoho Sign template a KVA-specific one, or does the org have a
   single "volunteer agreement" template?** Affects template configuration but
   not the data model.

5. **Scope of "explicit" designation — is cardholder/procurement tracked here or
   in an external system?** TOPDOWN notes "Key Volunteer Agreement gating
   (likely QB/Benevity's lane)." If the designation lives entirely outside the
   app, the explicit-designation half of this design is premature. The
   automatic half (role → KVA) stands alone.

---

## Provenance

- Backlog item **RB5** (`docs/backlog/INDEX.md`)
- TOPDOWN analysis: `docs/backlog/TOPDOWN.md` lines 143, 189, 195
- GitHub issue: #1317
