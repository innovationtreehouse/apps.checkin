# Intake note acknowledgement

## Problem

A family applying for membership is asked "anything else we should know?". A
household that already holds a valid background check writes its sentence there —
"treat us as a volunteer household", "we are asking for hardship consideration" —
and nobody ever reads it.

That is not a delay. Nothing is queued, nothing is late, and no screen shows the
sentence to anybody in the organisation. The family sees their application
proceed normally and assumes they have been heard.

Which families this happens to is not random. It is exactly the returning
volunteer household renewing for another year — the ones most likely to have
something worth saying, and the ones the field was added for.

## Objective

A note written by an applicant is read by a named person, and the record shows
who read it and what it said. Writing one costs the family nothing: it does not
slow their application, and it does not oblige them to a background check they
would not otherwise need.

## Executive summary

- **For applicants:** no change. Writing a note neither holds the application nor
  triggers a background check. It is now read.
- **For the board:** a list of applications carrying an unread note, worked like
  any other queue. One reader, not two. The readers are **board members** — this
  is settled, not open.
- **What deliberately does not change:** the note does not gate payment, does not
  gate membership, and does not enter the background-check review. Those
  couplings were removed on purpose and this does not restore them.
- **Cost:** three columns on the existing process record and a migration, one
  mutation, the snapshot write at two sites, one board-facing list, **raising
  `OrgMembershipProcess` to `pii` and re-clearing the four routes that return
  it — which rides with the schema change rather than a boundary PR of its own**,
  and the security-registry grant the list needs, shipping as its own change
  before the route.
- **What this PR does not do:** it does not edit `docs/rules/membership.md`. The
  access rule is relaxed to its policy limit by the implementation PR, using the
  replacement text fixed below.

## What changed under this design

This document was written against a `main` where an intake note held the
application at background-check review, and against #1499's proposal to remove
that hold. **#1499 has since merged**, and most of what this document argued
about is gone with it.

Moot now:

- **The payment hold.** `advanceExternalIfComplete` no longer inspects the note;
  the predicate that held a noted process at `PENDING_BG_REVIEW` is deleted, not
  moved.
- **The redundant background check.** Neither `submitIntake` nor `beginRenewal`
  disqualifies the fresh-check shortcut on a note any more. Both bind their
  shortcut unconditionally. A family no longer buys a check with a sentence.
- **Everything this document said about choosing where to gate.** Gating before
  payment is not an alternative that exists to be rejected; there is no longer a
  predicate there to change.

Still true, and still unaddressed:

- **The note reaches no human in the fresh-check case.** Verified against `main`
  with #1499 merged, and traced below. #1499 removed the coupling; it did not add
  a reader.

In-flight rows are not a concern. Processes parked at `PENDING_BG_REVIEW` by the
old hold sit with no clearance stamped, which is precisely the reviewer queue's
own predicate — they are in the queue, and their notes are shown. They leave it
the ordinary way, when the check clears.

## Rules this relies on or intends to change

Two rules in `docs/rules/membership.md` are in scope, and they are in scope
differently. **Neither is edited by this PR** — see "When the amendments land".

### The reviewer-reads rule — over-broad, plainly renegotiable

Under Procedure → Application and review:

> An intake note does not hold the application. It is shown to the reviewers,
> who read it while the family pays.
> (`checkin-app/src/lib/membership/external.ts`)  [Decision]

The first sentence is a standing decision and this design keeps it. **The second
sentence is over-broad and this design intends to correct it.** It is true only
of applications that enter the background-check reviewer queue, and the
fresh-check household never does — which is the whole of the problem above. The
register currently promises a reader that the code does not provide.

The tag is a plain `[Decision]` — "a choice we made, renegotiable in review"
(`DOCUMENTATION_STANDARD.md` §3.6). Nothing outside this repo has to move for it.

### The access rule — Policy-tier, and stricter than its policy

Under Procedure → Renewal:

> An intake note is readable by the household's leads and the reviewers, not by
> its other members.  [Decision — *Policy: Membership Policy, Art. VI §VI.2;
> Records Policy, Art. IV*]

The tag is the load-bearing part, and it is a different tier from the one above.
Board members are not inside this rule as written, and the list this design
proposes is board-facing.

**Relaxing this rule is the manoeuvre §3.6 warns about, so it is recorded here
rather than assumed.** The tier table's entry for `[Decision — *Policy: …*]`:

> the app's specific expression of a policy stated generally above — a threshold
> picked, a proxy chosen, need-to-know made concrete for one field. Sometimes
> **stricter** than the policy requires, in which case say so: the risk is
> someone relaxing it while believing they are aligning to policy.

That is this case exactly, and the risk it names is exactly the mistake available
here. So, on the record:

- **The rule is stricter than the policies it cites.** `Membership Policy,
  Art. VI §VI.2` and `Records Policy, Art. IV` already permit board members to
  read intake notes. The rule in `docs/rules/membership.md` is a narrower
  app-level expression of them, not a restatement of their limit.
- **The policy text was read to establish this** — by the owner, against the
  policy documents themselves. It was *not* inferred from the rule's wording, and
  *not* deduced from the board owning the membership process. Inferring it is
  precisely the failure §3.6 describes, and the distinction is the reason this
  bullet exists.
- **The amendment relaxes the rule to the policy limit, not past it.** The
  household's other members stay outside; the leads and the reviewers stay
  inside; the board joins them. The rule keeps its tier and both anchors, because
  after the amendment it is still the app's specific expression of those two
  policies — it simply no longer draws the line tighter than they do.
- **The policies are not in this repository.** Per §3.10 they live on Google
  Drive, which is the canonical source. **A future reader cannot re-verify this
  claim from the codebase** — no grep, no test, and no file in this tree
  establishes what `Art. VI §VI.2` permits. Checking it means opening the policy
  documents on Drive, and §3.10 requires checking them *there* rather than any
  local or cached copy, since a copy predating an amendment would enshrine a
  superseded rule behind a citation that still looks correct.

### When the amendments land, and why not here

**This PR does not edit `docs/rules/membership.md`.** #1525 is a design doc and
the board-facing list does not exist yet. Amending the access rule now would put
a rule in the register that the app does not implement, and §3.7's reason applies
directly — *"a reader who finds their answer stops reading"*. A register
describing a surface nobody has built is worse than one that is merely narrow.

Both amendments land **in the implementation PR that ships the list**, in that
same change. The replacement text is fixed here so the implementer does not
re-derive it:

**Replace, under Procedure → Renewal:**

```markdown
- An intake note is readable by the household's leads, the reviewers, and the
  board, not by its other members.  [Decision — *Policy: Membership Policy,
  Art. VI §VI.2; Records Policy, Art. IV*]
```

**Replace, under Procedure → Application and review:**

```markdown
- An intake note does not hold the application. Every note is read and
  acknowledged by one named person, and the record shows who read it and what it
  said.  [Decision]
```

The second replacement drops "shown to the reviewers, who read it while the
family pays" because that clause is the falsehood this design was written to
correct. It also drops the `external.ts` hint, deliberately: that path pointed at
the clause being removed, and the replacement's enforcement is spread across the
two snapshot write sites and the board list — no single file to point at. §3.5
allows this ("most rules need none") and a hint pointing at the wrong file is
worse than none.

Neither replacement names a screen or a route: which surface carries the list is
mechanism, and §6.13 keeps mechanism out of the register.

## The rule

**If a note is provided, a named person reads it, and the record says who and
what.**

Reading is an acknowledgement, not a decision. One reader. It is not the
two-of-N background-check review and must not be coupled to it.

## Design

### Where the note is lost

Three surfaces render `Household.intakeNotes`. Two are the family's own and both
are gated to household leads — the household view behind `GET /api/household`,
and the intake prefill's `canSeeNotes` branch. Only one is organisation-facing:
the background-check reviewer queue, `GET /api/membership/reviews`, which selects
the note and renders it on the review screen.

Nothing else reaches it. The ops people-search and the participant-merge analyzer
both project the household explicitly and comment on excluding it.

That queue's row set is `eligibleReviewProcessIds`, which filters on
`awaitingBgReview.where` in `lib/membership/lifecycle.ts`. That predicate requires
no clearance to have been stamped.

`submitIntake` stamps clearance at intake when a household guardian already holds
a valid check. So the fresh-check process is cleared before it could ever be
listed, never appears in the queue, and its note is rendered nowhere. The note is
stored, and read by no one.

Renewals take the same path through `beginRenewal`, which is why the common case
is the broken one.

### Recommended: surface it, do not gate

The gate this document originally proposed — no membership becomes `ACTIVE` while
a live note is unacknowledged — was designed when a note already held the
application. It no longer does, and `docs/rules/membership.md` now says so as a
standing rule. **Re-adding a gate on activation is re-adding a hold**, and would
need that rule amended rather than merely qualified.

The diagnosis does not ask for a gate. Nothing is stuck; something is invisible.
The cheap and sufficient fix is the reader, not the block:

- A board-facing list of applications whose note has not been acknowledged,
  oldest first, with the note shown and an "acknowledged" action.
- The acknowledgement recorded against the process.

This dissolves, rather than answers, the expensive questions the gated version
carried: where a note-blocked process sits, which entry edges must consult a
predicate, what happens to a household stranded after paying, and what to do
about processes already in flight. None of them arise if nothing is held.

The price is honest and worth stating: **an unread note stops nobody**. A
household that asked for volunteer dues can be activated at full dues before
anyone reads the request. That is the same trade #1499 already made deliberately,
and the remedies it relies on exist — the volunteer designation, the scholarship
hold ledger, and the finance refund path. The list is worked, or the note is not
acted on; there is no technical substitute for working the list.

### The gated alternative, and what it now costs

Recorded because it was the previous decision, and because its cost was
understated rather than argued.

`ACTIVE` has **six** entry edges in `TRANSITIONS`, not the five this document
previously tabulated:

| From | Event | Site | Kind |
|---|---|---|---|
| `PENDING_EXTERNAL_ACTION` | `markContractSigned` | `external.ts` | `PERSON_AGREEMENT` |
| `PENDING_PAYMENT` | `activate` | `payment.ts` | |
| `PENDING_PAYMENT` | `grantRenewalPayment` → `activate` | `renewal.ts` | `RENEWAL` |
| `PENDING_BG_REVIEW` | `clearBackgroundCheck` | `review.ts` | |
| `PENDING_BG_CLEARANCE` | `clearBackgroundCheck` | `review.ts` | |
| `BLOCKED` | `overrideBlocked approve` | `review.ts` | |

**The `PERSON_AGREEMENT` edge is out of scope for the predicate, and the reason
is structural rather than a judgement.** A `PERSON_AGREEMENT` process is opened
with no membership — `orgMembershipId` is null by construction, and
`markContractSigned` flips it straight to `ACTIVE` on the signature alone,
skipping `advanceExternalIfComplete` entirely because that function would
dereference the null. There is no household behind the process, so there is no
intake note that could have gone unread. A predicate reading the note through the
membership must return "nothing to acknowledge" for this edge rather than throw,
and the drift test must assert that exemption by name over all six edges — an
exemption nobody can see is the same failure as an edge nobody counted.

Two further corrections to what this document previously claimed:

- **The mechanism it asked for mostly exists.** `lib/membership/lifecycle.ts`
  already carries `INVARIANTS` and `validate`, and `classify` is an exhaustive
  switch that fails to compile when a status is added. The ask is one `INVARIANTS`
  entry plus the existing transition oracle, not a new pattern. The caveat matters:
  `INVARIANTS` is a **detection** oracle, not an enforcement gate. It gives the
  drift test, never the gate itself.
- **The nearest existing invariant is already blind to the sixth edge.**
  `active-is-bg-cleared` asserts that an `ACTIVE` row carries a clearance stamp.
  A settled `PERSON_AGREEMENT` is `ACTIVE` with no clearance — it never had a
  background check to clear — and `scanLifecycleViolations` runs `validate` over
  every process row without filtering on kind. The named sibling this design
  wanted to copy is, on `main`, reporting every completed person agreement as an
  off-diagram row. That is a defect in its own right and belongs in its own
  change; here it is the evidence. An invariant written against an incomplete
  edge inventory does not fail loudly — it fails as noise nobody reads.

A gate would also need a holding state. There is no honest existing candidate:
`PENDING_BG_CLEARANCE` means "paid, waiting on the board" but names the wrong
thing, and a new status pulls in new edges, a regenerated
`docs/generated/lifecycle/membership.md`, and both oracles. That work is real and
was not in the original cost.

### Model

Three columns on `OrgMembershipProcess`, not a new model:

```prisma
  /// The note as submitted with this application. Snapshot, not a live read: the
  /// household may edit or clear its note afterwards, and the audit question is
  /// what the applicant actually said.
  /// @sensitivity:pii
  intakeNoteSnapshot String?
  /// Who read the snapshot, and when. Staff-action audit metadata like every other
  /// actor/stamp pair on this model — internal, not public: who has read a family's
  /// note is not a fact the row publishes.
  /// @sensitivity:internal
  noteAckById        Int?
  noteAckBy          Person?  @relation("IntakeNoteReads", fields: [noteAckById], references: [id])
  /// @sensitivity:internal
  noteAckAt          DateTime?
```

`Person` gains the matching `intakeNoteAcks OrgMembershipProcess[] @relation("IntakeNoteReads")`
back-relation; Prisma will not generate without both sides.

**The acknowledgement pair is `internal`, not `public`.** It records *which
internal actor* acknowledged and when — a workflow stamp, not member-facing data.
Every other staff-action actor/stamp pair on this model is `internal`
(`manualPaymentById`, `bgClearedAt`, `contractSignedAt`, `paidAt`,
`renewalReminderSentAt`); what is `public` on `OrgMembershipProcess` is the row's
own identity and shape (`id`, `kind`, `orgMembershipId`, `subjectPersonId`,
`createdAt`). `SECURITY-POLICY.md`'s tier table puts this in `internal` by name:
*"Role/audit metadata."* The repo also carries the alternative going wrong —
`BackgroundCheckAttestation.reviewerId` is `public`, and `registry.ts` has to
defend against it at the route because it *"would tell reviewer B that reviewer A
already signed off"*. "Who has read this family's note" is the same shape of fact,
and `internal` is strictly narrower than `public`, so it widens nothing this
design contemplated.

The tier is load-bearing downstream rather than a detail: it is what makes the
board list's registry entry need `everyones:internal` **alongside**
`everyones:pii`, to render "acknowledged by X at T". Read as `public`, that entry
would appear to need the `pii` band alone.

Snapshotting at submit rather than acknowledging a live string is what makes the
record answerable a week later. It settles two questions outright — there is no
re-read semantics, and an edit does not re-open anything — and it makes renewals
per-cycle, because each process carries its own snapshot. The third question,
"was this edit material", it **narrows rather than settles**; see "Renewals: the
skip, and what it costs" below. A household editing its note after submit does
not reach the reader — correctly, since the note is part of the application it
was submitted with.

Retention: the snapshot is disclosure-equivalent to the note itself, and a
household clearing its live note to null does not clear the snapshot — that is
the point of taking one, and it needs stating rather than discovering. It is
deleted with the process and has no separate lifetime.

Where the note is empty at submit there is no snapshot and no obligation.

#### Where the snapshot is written

The three columns are inert until something writes them, and **the snapshot is a
different write from the acknowledgement**. The acknowledgement is the board's
action on `noteAckById`/`noteAckAt`, priced in Cost as one mutation. The snapshot
is a system write at process advance, and it needs a site per kind.

**`submitIntake` (`lib/membership/intake.ts`) — cheap, but not for the reason it
first appears.** `submitIntake` does *not* write `intakeNotes`. That write lives
in `saveIntake`, the earlier save that also normalizes the address, and by submit
time it has already happened; the snapshot cannot ride it. What makes the submit
site cheap is different, and better:

- **No new read.** `loadUserWithHousehold` pulls the household with a full
  `include`, so `household.intakeNotes` is already in memory when `submitIntake`
  runs.
- **No new write.** `submitIntake` already issues one
  `prisma.orgMembershipProcess.update` to advance `INTAKE` →
  `PENDING_EXTERNAL_ACTION` and stamp `bgClearedAt`. The snapshot is one more
  field on that `data`.

Unlike the renewal site, that advance is an unconditional `update` by id rather
than a status-conditional `updateMany`. A concurrent double-submit there is a
pre-existing race that this design neither worsens nor fixes.

**`beginRenewal` (`lib/membership/renewal.ts`) — not cheap.** #1499 removed the
note read: the membership lookup now selects `householdId` alone, where it
previously pulled the household's note to compute `hasNote`. So renewals need a
**new read as well as a new write**.

The write must land **inside** the existing conditional `updateMany` on
`PENDING_RENEWAL` — the one whose comment reads *"a double-submit has both
callers reach here, but only the winner's updateMany flips it (count === 1) — so
the audit row is written exactly once."* That comment is the specification, not
commentary: attached outside the `updateMany`, a double-submit snapshots twice.

#### Renewals: the skip, and what it costs

"Renewals are per-cycle" is free on the read. On the write it is a defect, and
the defect is worth stating before the fix.

Nothing re-prompts the family at renewal. `POST /api/membership/renew` reaches
`beginRenewal` directly — a signature flow with no intake form in it — and
`intakeNotes` lives on `Household`, editable by a lead from household settings at
any time and untouched by anything in the renewal path. So the sentence
snapshotted onto a renewal process is whatever has been sitting on that row,
possibly for years.

A household that once wrote *"treat us as a volunteer household"* therefore
produces a fresh unacknowledged snapshot **every renewal, indefinitely**, with
nothing marking it as text a board member has already acknowledged three times.
Dropping the gate makes that non-blocking, not harmless: it is a queue that
refills annually with re-reads of identical sentences, which is how a list stops
being worked — **and the list being worked is the entire enforcement mechanism
this design has.**

**The fix, adopted:** at the write site, skip the snapshot when the text is
byte-identical to the most recent acknowledged snapshot on that membership. No
snapshot, no row on the list, no obligation.

**Its cost, stated plainly: this displaces the edit-materiality question rather
than eliminating it.** The snapshot is credited above with removing "was this
edit material", and against a live, still-editable string it does. The skip puts
a smaller version of the same question back — exact equality across cycles rather
than materiality against a live string. That is genuinely easier: byte comparison
needs no judgement and no definition of "material". But it is still a comparison,
and a household that rewords the same request lands back on the list. That is the
right direction to fail in, and it is not nothing.

#### The boundary cost of a `pii` column here

`intakeNoteSnapshot` would be the **first `pii` field on `OrgMembershipProcess`**.
The model's ceiling today is `personal`, held by `shopifyInvoiceUrl` alone;
every other field is `internal` or `public`. This raises the ceiling for the
first time.

**Four registered routes return the model in their view bag**, and all four are
re-cleared against the new tier:

| Route | Band today |
|---|---|
| `POST /api/membership-audit/person-agreement` | `everyones:internal`, `public` — **no pii band at all** |
| `GET /api/membership-ops/applications` | `everyones:pii` and below |
| `GET /api/membership/reviews` | `everyones:pii`, `member`, `public` |
| `GET /api/finance-ops/membership-payment-plans` | `everyones:pii` and below |

That re-clearing, plus regenerating `src/security/generated/classifications.ts`,
**rides with the schema change rather than shipping in its own PR**:
`security-boundary-isolation.yml` excludes
`checkin-app/src/security/generated/*` from `is_boundary()`, and annotating new
columns is not the re-tier of an existing field that its only other trigger looks
for. The previous revision's Cost budgeted the new list's registry grant and not
this re-clearing; it is priced below.

**The argument that keeps the note narrow today does not transfer, and this
paragraph exists so the next person finds that out from the doc rather than the
hard way.** `registry.ts` argues explicitly that `Household.intakeNotes` is out
of reach for `programLeadMentor` and `programCoreVolunteer` because *"Household
binds no scope beyond their_households, so a their_program_households token
resolves to nothing on a Household row."* **That argument is about `Household`'s
bindings.** On `OrgMembershipProcess` the conclusion still holds, but for an
entirely different reason: that model is **unbound**. `scopeBindings.ts` lists it
in `OPT_OUT_PENDING_ROUTE`, annotated *"board/admin today; a household-facing
status route is plausible."* That set is a work queue rather than a permanent
exemption — each entry leaves it in the same PR that ships its scoped route.
**Whoever ships that household-facing route will be binding a model that by then
carries pii, with the reasoning that kept the note narrow living in a comment
attached to a different model.**

#### A correction this design owes its review

The snapshot-on-process shape was recommended over a separate
`IntakeNoteAcknowledgement` model, and **on the boundary axis the separate model
was the cheaper one**: it would have bound no scopes, appeared in no existing
view bag, and left all four registered routes untouched. That was not weighed
when the shape was chosen, and neither this document nor the review that
recommended it priced it.

The snapshot remains the chosen shape. It removes the re-open semantics, the
edit-materiality comparison against a live string, and a join table, and those
are worth more than the boundary work. But it buys that simplicity **with
boundary surface**, and the trade belongs here rather than in the implementer's
surprise.

### A note on citations

This document cites files and symbols and deliberately carries **no line
numbers**. The previous revision's citations were copied from the transition
table's own `guardSite` strings, and by the time it was reviewed most pointed at
the wrong function — including the strings on `main`, which have drifted from the
code they describe. A symbol name is checkable and does not rot on an unrelated
insertion.

Rules in `docs/rules/membership.md` are therefore cited here by **section heading
plus quoted text** — "Procedure → Renewal", and the sentence itself — never by
line. The review of this document supplied the live counterexample: it quoted the
access rule at `membership.md:302`, #1579 landed an edit above it and moved the
rule to 308, and by the time these changes were written it had moved again, to
314. Three numbers, one unchanged rule, and nothing in the file's own content
signalling the drift. A heading and a quotation survive all of it, and a reader
who cannot find the quoted sentence learns something real — that the rule
changed — instead of silently reading the wrong line.

## What this is not

- **Not a decision.** Acknowledging is not approving and carries no verdict. If
  the note asks for something, acting on it is a separate existing workflow.
- **Not two-of-N.** One reader. Two people share a background-check judgement;
  reading a sentence is not that.
- **Not a background-check hold.** The tracks do not touch, and this must not
  reintroduce the coupling #1499 removed.
- **Not a restoration of the fresh-check disqualification.** A household holding
  a valid check does not consent to a redundant one in order to be seen.
- **Not a gate.** See above; this is the reversal from the previous revision.

## Open questions

Numbering is kept from the reviewed revision so the review still lines up against
it. 1 and 3 are now answered; only 2 is open.

1. **Who counts as a reader? — ANSWERED: the list is board-facing.** Board
   members read it. `canReviewBackgroundChecks`, the existing queue gate, is
   broader than the board and is **not** the gate for this list. Reviewers keep
   the note where they already see it, on `GET /api/membership/reviews`; they do
   not gain the new list. This settles the security grant, which is why it had to
   be answered before the registry change rather than after.

2. **What happens if the list is not worked?** *(open)* With no gate the answer
   is milder than it was — nobody is stranded — but the note is still unread. The
   byte-identical skip keeps the list from refilling with sentences already
   acknowledged, so what remains on it is genuinely unread; that makes the
   question sharper, not softer. A staleness notice to the board after some
   interval is the cheap answer. This is a commitment question, not a technical
   one.

3. **Does the board list widen who may read a note? — ANSWERED: yes, and the
   widening is a relaxation to the policy limit rather than past it.** The access
   rule is Policy-tier and stricter than `Membership Policy, Art. VI §VI.2` and
   `Records Policy, Art. IV` require; the owner read those policy documents to
   establish that, and they are on Drive rather than in this repo. The rule is
   amended **in the implementation PR**, not this one, and the exact replacement
   text is fixed above. **This PR does not touch `docs/rules/membership.md`.** See
   "Rules this relies on or intends to change".

## Cost

- Three columns and a migration.
- One mutation to record the acknowledgement.
- **The snapshot write itself, at two sites.** One extra field on the existing
  `orgMembershipProcess.update` in `submitIntake`; in `beginRenewal`, a new read
  of the household's note plus a write placed inside the existing conditional
  `updateMany`, with the byte-identical skip at both.
- **Raising `OrgMembershipProcess`'s ceiling to `pii` — which rides with the
  schema change rather than shipping alone.** Re-clear the four registered routes
  that return the model against the new tier and regenerate
  `src/security/generated/classifications.ts`. There is no separate boundary PR:
  `security-boundary-isolation.yml` excludes
  `checkin-app/src/security/generated/*` from `is_boundary()`, and its only other
  trigger is a re-tier of an existing field, which annotating new columns is not.
  **The previous revision missed this item entirely.**
- One board-facing list route and screen.
- **The security-registry grant for that list, as its own change, merged before
  the route.** The registry carries an explicit guard against granting a
  household-scoped pii token to a lead- or keyholder-facing view returning
  household rows; reviewers reach `intakeNotes` today through the reviewer grant
  on `GET /api/membership/reviews`. A new board-facing surface cannot borrow it.
- **The two `docs/rules/membership.md` amendments, in the implementation PR** —
  text fixed above, so this is transcription rather than a decision.

The registry grant is the only boundary item above; what AGENTS.md fixes is that
no feature code rides along, and that the registry entry lands before the route
that uses it.

No cutover: nothing in flight is held, and no existing row needs moving. Per §4.2
there is no migration document, because nothing here expires on a nameable date.

## Appendix — provenance

The note field was added in #900 and the hold in #907. #1499 removed the hold and
restored the fresh-check shortcut; this document was written as a response to
#1499's proposal and has been re-derived against it as merged.
