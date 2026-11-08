# Person-based background-check review

## Answer

Yes. Background-check review should be per person, and a household's eligibility
should be computed from its people's checks.

The most serious result of today's design is a gap against Policy. Membership
Policy, Art. IX, says nobody whose check fails may be a member. In the app, an
adult whose own check was rejected stays in a member household. The household
then renews without any new review, as long as another lead's check is still
valid. The code allows this today. As of 2026-11-07 no review in production is
rejected, so no household is in that state yet. PBR-1 settles the rule.

The cause is that the app reviews checks in two ways that store the same facts
differently. A household application's review names one adult. A per-person
review covers everyone else. Each has its own rejection and its own Board reset,
and the two never consult each other. That is also why one lead can be under two
separate reviews of the same report at once, and why a household rejection
doesn't record whose check failed.

The move is cheap because the per-person review already exists and already does
everything a review needs: two independent approvals, rejection, reset, change to
approve, undo, consent and the reviewer queue. The proposal makes it the only kind
of review. The person who applies may not be the person whose report comes back.
So a review opened by a household's consent starts without a person, and the first
reviewer's decision names them, whether it approves or rejects. A household
application stops holding attestations and instead asks one derived question:
*does at least one lead hold a valid clearance, and does no adult in the household
hold a standing rejection?* One nullable column is added; no table is added or
dropped. The one or two household reviews in progress restart and are reviewed
again, so no legacy path survives. Their old attestations stay where they are as
history.

## Problem

A background check is taken by one person and read by reviewers about that person.
Policy treats it that way: a check covers the adult who took it, every adult in a
family who is present regularly is checked, every volunteer 18 or over is checked,
and nobody whose check comes back without clear recognition may be a member.

The app records reviews in two places. When a family applies or renews, its
reviewers approve or reject the *application*, and the first approver names which
adult's report they read. A rejection names nobody. For any other adult, such as
the second parent, an adult child or a volunteer, a separate per-person review is
opened. The two are counted by different rules and reset by different buttons, and
neither checks the other. So:

- A spouse whose own review was rejected stays a member, and the household renews
  on the other parent's still-valid check without anyone reviewing again.
- A parent whose check has gone stale can be under a per-person review (opened by
  the yearly sweep) and a household renewal review (opened by the renewal) at the
  same time. Two pairs of reviewers read one report, and the two reviews can reach
  different answers.
- A household rejection doesn't say whose check failed, so nothing later (a merge,
  a renewal, a reviewer) can tell which person is in dispute.
- A person merge has to know about both tracks, and today it reads only one of
  them.

## Objective

Once this lands, each person has one background-check history: their reviews,
each reached by two independent reviewers, the clearances those reviews produced,
and any rejection or reset still in force. Every household question (may this
application activate, may this household renew, does this renewal need a new check)
is answered from that history and nothing else.

## Executive summary

| Who | What changes | What does not |
|---|---|---|
| Reviewers | Every queue card is a check review. One opened by a household's consent has no person yet, and its first reviewer names whose report they read, on a rejection as well as an approval. | Two independent reviewers, the own-household bar, reject, change to approve, undo. |
| Applying family | Nothing visible. Consent opens a review for the household; nobody assumes the consenting lead is the person checked. | Stepper, payment, agreement, consent step. |
| Board | Reset applies to a person's review. A rejection of any adult in a household blocks that household's open application (see PBR-1). | Deny, restore, grant, close, refund. |
| Merges | Refused while either side has a disputed check that the merge would change (owner ruling 2026-11-07). The household-only carry-forward code goes away. | Newer date carried, archive kept, no un-merge. |
| Data | One nullable column. The one or two in-flight household reviews restart and are reviewed again; no legacy path is kept. | Every attestation and audit row stays. |

Cost: about eight small PRs and one additive column, no data migration. The largest unknown is how many
household reviews are in flight or blocked on the live database (§5.1).

---

## 1. Facts as built

Paths are relative to `checkin-app/`. Line numbers are against `main` at
`5d4c53166`.

### 1.1 The kinds of review

Two review kinds, both rows of `OrgMembershipProcess`
(`prisma/schema.prisma:536`), both holding `BackgroundCheckAttestation` rows
(`prisma/schema.prisma:655`):

| | Household application review | Per-person review |
|---|---|---|
| Kind | `INITIAL` / `RENEWAL` | `PERSON_BG` (`prisma/schema.prisma:444`) |
| Who it is about | `orgMembershipId` set, `subjectPersonId` null | `subjectPersonId` set, `orgMembershipId` null |
| "Named adult" | Each APPROVE attestation's `subjectPersonId` (`schema.prisma:670`), the first approval fixes it (`src/lib/membership/approvals.ts` `establishedSubject`), validated against live leads (`src/lib/membership/review.ts:410` `namedSubject`) | The process's own `subjectPersonId` |
| Rejection | REJECT attestation with null subject; process → `BLOCKED` (`review.ts:366-372`) | Same, process → `BLOCKED` |
| Board reset | `boardResetReview` deletes attestations, keeps them in the audit row `action: "board reset"` (`review.ts:715-757`); resumes at `PENDING_PAYMENT` / `PENDING_BG_CLEARANCE` / `PENDING_EXTERNAL_ACTION` (`review.ts:776`) | Same function, resumes at `PENDING_BG_REVIEW` |
| Change to approve | `switchRejectionToApprove`, audit `action: "rejector changed to approve"` (`review.ts:429-459`) | Same |
| Undo own approval | `undoOwnApproval` (`review.ts:467`) | Same |
| Consent | `bgConsentAt` on the household row (`schema.prisma:585`), recorded by a lead or the board, naming no person (`src/lib/membership/external.ts:226`, `:305`) | `bgConsentAt` on the person row, by the subject or by the board submit (`src/lib/membership/personBgSubmit.ts:30`) |
| Clearing count | Approvals naming the established subject (`review.ts:379-381`, `approvals.ts` `approvalsForSubject`) | Every approval |
| What clearing writes | `Person.lastBackgroundCheck` for the named subject only (`review.ts:569-573`), `bgClearedAt` on the process, then pay/activate convergence (`review.ts:560-588`) | `lastBackgroundCheck` on the subject, process → `ACTIVE` (`review.ts:533-548`) |
| Gates anything? | Yes: activation needs `bgClearedAt` and payment | No: warn-only (`docs/rules/membership.md`, "Background checks for individual adults") |

There is no third kind of review. `PERSON_AGREEMENT` and `KEY_VOLUNTEER_AGREEMENT`
share the table but carry no attestations. Trusted-adult review
(`TrustedAdultReview`, `schema.prisma:937`) is a separate Board decision, not a
background-check review.

The shared state: `Person.lastBackgroundCheck` (`schema.prisma:138`) is the only
clearance date anyone reads. Validity is derived from it plus
`BoardSettings.bgRecheckMonths` (`schema.prisma:737`); when that setting is unset,
every check counts as expired (`src/lib/membership/bgRecheckPolicy.ts`).

### 1.2 How each feeds the rest of the app

- **Clearance.** Both kinds clear through `clearBackgroundCheck` (`review.ts:516`).
- **Activation.** A household process activates when `bgClearedAt` and payment are
  both set (`review.ts:562`, `src/lib/membership/payment.ts` `activate`). A
  `PERSON_BG` never activates a membership.
- **Still-valid-check shortcut.** `householdBgIsFresh` (`src/lib/membership/renewal.ts:384`)
  asks whether *any lead* has `lastBackgroundCheck` inside the window. It never
  looks at any review, open or blocked. Callers: intake (`src/lib/membership/intake.ts:572`),
  renewal (`renewal.ts:258`), compliance STALE_BG (`src/app/api/membership-audit/compliance/route.ts:86`),
  merge (`src/lib/membership/mergeBgAdvance.ts:43`, `:60`).
- **Renewal.** `beginRenewal` refuses a household with a `BLOCKED` application,
  reading `INITIAL`/`RENEWAL` rows only (`renewal.ts:263`). A blocked `PERSON_BG`
  on a lead does not stop it.
- **Per-person obligations.** `openPersonBg` (`src/lib/membership/personBgTriggers.ts:35`)
  opens one for anyone in `bgObligatedWhere` (`src/lib/person/filters.ts:74-79`):
  program-attached people plus leads of ACTIVE households. It skips anyone with a
  `PERSON_BG` already open or blocked (`personBgOpen`, `src/lib/membership/lifecycle.ts:115`),
  and it never checks for an open household review that names that same lead.
  Triggers: the daily cron (`runPersonBgAnnualSweep`), activation of a new
  membership (`review.ts:663`, `payment.ts:265`), board submit (`personBgSubmit.ts`).
- **Programs.** Not enforced; the rule says so (`docs/rules/programs.md`, "Nothing
  checks that a program leader…"). Program-attached adults get a `PERSON_BG`
  obligation through the triggers above.
- **Volunteer roles and supervision.** The two-deep count reads the person's own
  `lastBackgroundCheck` plus an ACTIVE household (`src/lib/supervision.ts:114`).
- **Compliance views.** STALE_BG per household, PERSON_BG_NEEDED per person, a
  blanket-stamp detector for legacy household clearances that stamped every lead
  (`compliance/route.ts:163-200`), and the attestation audit page
  (`src/app/membership-audit/bg-attestations/page.tsx`).
- **Merges.** The newer `lastBackgroundCheck` is always carried to the keeper
  (`src/lib/person/merge/plan.ts:185-187`). Attestations are re-pointed on both
  the reviewer and subject sides, with three collision refusals (`plan.ts:253-292`).
  Duplicate open `PERSON_BG` rows are archived, and a `BLOCKED` one outranks an
  open one (`src/lib/person/merge/execute.ts:687`). After commit,
  `advanceHouseholdBgAfterMerge` (`mergeBgAdvance.ts:79`) clears the keeper's
  household application if the merge made a lead fresh. It skips rows with a
  REJECT or a past `"board reset"` audit row (`mergeBgAdvance.ts:104`, `:137-138`).
  It reads household rows only (`mergeBgAdvance.ts:113-117`). Nothing in a merge
  reads a `BLOCKED` `PERSON_BG` before carrying the date.

### 1.3 Every caller of the household review

| Entry | Path | Calls |
|---|---|---|
| Queue, actionable / mine / rejected | `GET /api/membership/reviews` (`src/app/api/membership/reviews/route.ts:39-41`) | `eligibleReviewProcessIds`, `attestedUnclearedProcessIds`, `ownRejectedProcessIds` |
| Attest, change to approve | `POST /api/membership/reviews` (`reviews/route.ts:101`) | `attest` → `namedSubject`, `switchRejectionToApprove`, `clearBackgroundCheck` |
| Undo | `POST /api/membership/reviews/undo` | `undoOwnApproval` |
| Board reset | `POST /api/membership-ops/applications/review-override` (`route.ts:29`) | `boardResetReview` |
| Consent, applicant | `POST /api/membership/bg-consent` | `selfRecordBgConsent` → `markBgConsent` |
| Consent, board | `src/app/api/membership-ops/applications/external/route.ts:62` | `markBgConsent` |
| Consent, dev only | `src/app/api/dev/bg-consent/complete/route.ts:34` | `markBgConsent` |
| Nav and notification counts | `src/lib/nav/todoCounts.ts:165`, `src/lib/membership/notifications.ts:24` | `reviewQueueCounts`, `eligibleReviewProcessIds` |
| Duplicate-attestation cleanup | `DELETE /api/membership-ops/bg-attestations/[id]` | direct delete + audit |
| Merge | `prepareMerge` / `executeMerge` (`execute.ts:137`, `:229`), preview `participants/merge/analyze/route.ts:191` | `householdBgFresh`, `advanceHouseholdBgAfterMerge`, `mergeBgNotice` |
| Shortcut | intake, renewal, compliance | `householdBgIsFresh` |
| UI | `src/app/membership-ops/review/page.tsx` (subject picker), `src/app/membership-ops/applications/page.tsx:200` (progress count) | `establishedSubject`, `clearingApprovals` |

Security registry entries exist for `GET /api/membership/reviews`,
`POST /api/membership/reviews/undo`, `DELETE /api/membership-ops/bg-attestations/[id]`
and `GET /api/membership-audit/bg-attestations` (`src/security/registry.ts:377-588`).
`BackgroundCheckAttestation` has a scope binding (`src/security/scopeBindings.ts:183`).

### 1.4 Not confirmed

- **Live counts.** I have not read the live database. The migration in §5 depends on
  how many household rows are in flight, blocked, reset-and-waiting, or carry an
  unnamed approval. §5.1 gives the read-only query.
- **The other routes.** I did not trace which routes go through `handler()` with a
  registry entry and which authenticate directly. PR 3 must re-check this before
  it touches a response shape.
- **`RENEWAL_PENDING_BG` rows.** The code treats them as legacy (`lifecycle.ts:73`).
  Whether any remain live is unknown.

---

## 2. Is the owner's diagnosis right?

Yes. The two tracks record one kind of fact, "these two reviewers read this
person's report and judged it", but they key it differently. The household track
keys it to an application and adds a field naming the person. The per-person track
keys it to the person. Each consumer then has to know which track to read, and
several read only one.

**Contradiction (a rejected adult stays a member).** Lead A is named on the
household's joining review and cleared. Later the yearly sweep opens a per-person
review for lead B, and two reviewers reject it. B's review is now `BLOCKED`, but it
gates nothing. At the next renewal, `householdBgIsFresh` sees A's still-valid
check and stamps the renewal cleared (`renewal.ts:258`, `:270-273`). `beginRenewal`
looks for a blocked *household* row and finds none (`renewal.ts:263`). The household
renews with B in it. Policy says nobody whose check comes back without clear
recognition may be a member (Membership Policy, Art. IX).

**Duplication (one report, two reviews).** Lead A's check has gone stale, and the
household is ACTIVE. The daily sweep opens a `PERSON_BG` for A, because leads of
ACTIVE households are obligated (`filters.ts:77`). The Board opens renewals, the
household starts its renewal, and the shortcut fails because A is stale, so the
renewal needs a review. A lead consents, and the household review enters the queue.
Reviewers now see two cards for one report. If the first pair clears A's
`PERSON_BG` first, the household review still needs two more approvals naming A.
If one card is rejected and the other approved, A is cleared and in dispute at the
same time. Nothing reconciles the two.

**Loss of information.** A household rejection names nobody (`schema.prisma:664-669`,
`review.ts:353-360`). So the app can't tell whose check is disputed, and a merge
can't tell whether the person it is about to give a fresh date to is the one who
was rejected. `mergeBgAdvance` handles this by refusing to stamp a household row
that carries any rejection (`mergeBgAdvance.ts:137`). The opposite case goes
unguarded: a merge carries a fresh date onto a person whose own `PERSON_BG` is
`BLOCKED`, because no merge code reads that row before the date moves
(`plan.ts:185-187`).

**What the second track really is.** The rule "a clearance covers only the adult
who took the check" (`docs/rules/membership.md`, "Background checks for individual
adults") was right, and the per-person track was built to honour it. But it was
built *beside* the household review rather than *instead of* it, so the household
review kept its own copy of the judgment. That copy is the defect.

---

## 3. Proposed model

### 3.1 One review per person

A **check review** is today's `PERSON_BG` process: attestations from two
independent reviewers, `BLOCKED` on rejection, reset and change-to-approve as now.
It is the only place a reviewer's judgment is recorded. Once a review has a person,
that person has at most one review open or blocked, as `personBgOpen` enforces
today.

**Who the review is about is known only from the report.** The person who applies
or consents may not be the person whose report comes back; a lead often consents
for a check the other parent took. So a review opened by a household's consent
starts with **no subject**. It carries the household it was requested for, and its
subject is fixed by the **first reviewer decision**, approve or reject. That
reviewer names the adult whose report they read, chosen from the household's leads
as today. From then on it is that person's review, and the second reviewer confirms
the same person. A rejection names its person too. That is new, and it is what lets
a rejection make a *person* disputed instead of an application.

Every way a check gets started:

- A household application or renewal records consent → a review with no subject,
  requested for that household. No code infers the subject from who consented.
- The Board recording an external check for a named person
  (`submitPersonBgForReview`, unchanged) → a review with that subject.
- The yearly sweep and the new-member trigger → a review with that subject
  (unchanged).

**Naming a person who already has a review open.** If the named adult already has
an open or blocked review of their own, the first decision is refused if that
review has any attestation or is blocked: the reviewer reviews them there. If that
review has no attestations, it is closed with an audit row naming the request that
replaced it (PBR-11). No attestation ever moves between reviews.

**A reviewer who thinks the named person is wrong** asks the Board to reset. A
rejection now says that person's check failed, so it can't also mean "wrong
person" (PBR-12). The reset returns the review to no subject, and the next first
decision names again.

A person's **check standing** is derived from their reviews and their date:

| Standing | Meaning |
|---|---|
| `CLEARED` | `lastBackgroundCheck` inside the window, and no review blocked or reset-and-waiting |
| `DISPUTED` | a review is `BLOCKED`, or was Board-reset or changed-to-approve and has not cleared since |
| `PENDING` | a review naming them is open with consent, nothing disputed |
| `NONE` | none of the above |

`DISPUTED` beats `CLEARED`. A person who holds an old clearance and whose new review
was just rejected is disputed. A review with no subject yet counts toward nobody's
standing; it keeps its household's application waiting.

### 3.2 What "the household qualifies" means

A household qualifies on its background check when both of these hold:

1. **At least one lead is `CLEARED`.** This is the Policy rule "at least one adult in
   each family is checked", and it matches what `householdBgIsFresh` tests today.
2. **No adult in the household is `DISPUTED`.** This is new. It is the Policy rule
   that nobody whose check fails may be a member (Art. IX), applied to the people the
   household actually contains.

A single function, `settleHouseholdBg(householdId)`, reads that predicate and moves
the household's open application. It runs after every check-review outcome (clear,
reject, reset, change to approve), after a merge, and after a household move:

- qualifies, application waiting on its check → stamp `bgClearedAt` and run the
  existing pay/activate convergence (the household half of `clearBackgroundCheck`);
- an adult becomes `DISPUTED`, application open → `BLOCKED`, with an audit row
  naming the person's review;
- the disputed review is reset or changed to approve → the application resumes at
  `blockedResetStatus`. It does not clear until the person clears again, because the
  person is still disputed until then.

A **denied** household's application is never moved. `settleHouseholdBg` leaves it
held whatever the person's review does, because neither a reset nor a change to
approve reopens a denied household (`docs/rules/membership.md`, Application and
review). The Board's release (§3.4) is refused for a denied household for the same
reason.

The application keeps `BLOCKED` as its status, so the Board queues, the payment
refund notice (`board.paidReject`) and every "a household with a blocked
application cannot…" rule keep working unchanged. The difference is that a person's
review writes the status; a household attestation never does.

The intake and renewal shortcut become the same predicate: an application that
qualifies on arrival is stamped exactly as today.

### 3.4 When a disputed person leaves a household

A dispute follows the person: any household they join is blocked by it, as in
§3.2. The application that was open when the rejection was decided stays
`BLOCKED`, so removing the rejected adult does not unblock their former household
on its own. A lead can't clear their household by removing a rejected spouse.

Real departures happen, a divorce for example, so the Board can **release** a
household from a departed person's rejection. The release:

- applies only when the rejected person is no longer in the household;
- needs a written reason, and is refused for the actor's own household and for the
  departed person's current one;
- returns the blocked application to `blockedResetStatus`. The person's review and
  its rejection are untouched, and they still block any household the person is in.

The release is the one new Board action in this design. It is not a reset: a reset
discards the rejection, and a release keeps it on the person.

### 3.3 Policy-tier check

| Policy rule | How the model meets it |
|---|---|
| At least one adult in each family is checked (Membership Art. VI §VI.1) | Clause 1. Unchanged in effect. |
| Any other family member 18+ present regularly is checked (same) | Stays a warn-only obligation through the per-person triggers, as today. The model does not make it a gate (PBR-3). |
| Every volunteer 18+ is checked (Volunteer Art. IV) | Same triggers, same record. A volunteer's review and their household's review are now one review. |
| No entry until the check completes (Art. VI §VI.1) | Activation still needs the application's `bgClearedAt`. |
| Valid 29 months (Art. VI §VI.1) | Unchanged. Validity still comes from `bgRecheckMonths` per person. The Board sets it. |
| Two independent reviewers, key volunteer agreement (Art. VI §VI.2) | Unchanged. It now applies per person review, the only kind. |
| A check may result in approval, restriction, or denial (Art. VI §VI.2) | Unchanged (restriction carried by the Board). |
| Nobody whose check fails may be a member (Art. IX) | Clause 2. This is stricter than today: today a failed per-person check blocks nothing. |

No Policy wording changes. The Decision-tier wording that changes, in
`docs/rules/membership.md`:

- *Application and review*: "A household review covers one adult…" and "An approval
  that named nobody…" are deleted. In their place: a check review is about one
  person, and the household's application is decided by the qualifies rule.
- "A single rejection blocks the application" becomes "a rejection of any adult in
  the household blocks its open application" (PBR-1).
- "A person merge that brings in a valid check…" is rewritten per §6.
- *Background checks for individual adults*: the bullet "A signing adult whom the
  household's own review did not name is covered here rather than by that
  review…" is deleted, because there is no second track. The bullet "A household
  lead's attestation goes to the household's application…" becomes "a lead's
  consent opens a review for the household, whose person the first reviewer
  names".
- "A reviewer who believes the named person is wrong rejects" becomes "asks the
  Board to reset" (PBR-12). "A household review covers one adult. Whoever approves
  first names the person…" becomes "whoever decides first, approving or rejecting,
  names the person".
- *Renewal*: "unless a lead's is still valid at the boundary" gains "and no adult in
  the household is disputed".
- New, under *Application and review*: a rejection follows the person, and the
  Board may release, with a reason, the household a rejected person has left; the
  rejection stays on the person.

In `docs/rules/people-households.md`, the merge bullet on membership standing is
rewritten per §6.

---

## 4. What it changes

**State machines** (`src/lib/membership/lifecycle.ts`).
- `PERSON_BG`: one new entry edge, ∅ → `PENDING_BG_REVIEW` by household consent,
  with no subject. Naming the subject is a field write at the first decision, not
  a status edge. A Board reset of a review opened by consent also clears its
  subject. The other edges are unchanged.
- Household kinds: the edges whose event is `attest REJECT`, `boardResetReview`,
  `attest change to APPROVE` and `clearBackgroundCheck` keep their from/to states,
  but their event becomes `settleHouseholdBg` (system actor, triggered by a person
  review).
- `awaitingBgReview` loses its household arm. The queue lists only `PERSON_BG`.

**Schema.** One nullable column, expand-only:
`OrgMembershipProcess.requestedForHouseholdId`, set on a `PERSON_BG` opened by
household consent and never changed. It is the link from an application to the
review it waits on while the review has no subject, and the candidate set the first
reviewer names from. It needs an `@sensitivity` annotation and regenerated
classifications. `subjectPersonId` on a `PERSON_BG` becomes nullable *in use* only:
the column already is nullable, and today's comment and code assume it is set.
Every reader of `kind: "PERSON_BG"` that dereferences the subject must handle null
(the review route, `applicantHousehold`, the merge's duplicate archive, the
attestation audit page).

For a review with no subject, the household the own-household bar checks is
`requestedForHouseholdId`. Today `applicantHousehold` returns null when a row has
neither a subject nor an `orgMembershipId`, and the queue filter then applies no
exclusion (`review.ts:151-161`, `:223-224`). An unnamed review must never reach
that branch: a reviewer in the requested household is refused, as they are today
on a household application. Once the subject is named, the bar checks the
subject's household, as on every `PERSON_BG`.

The alternative, reusing `orgMembershipId` on `PERSON_BG` rows, is rejected. Code
in several places (`mergeBgAdvance.ts:17-21`, `payment.ts:71`,
`finance/matchAudit.ts:258`) relies on `orgMembershipId` excluding `PERSON_BG`, and
breaking that would turn those readers into membership readers.

`BackgroundCheckAttestation.subjectPersonId` stops being written on household rows
and is kept: it is the record of whose report each historical approval read.
`OrgMembershipProcess.bgConsentAt` on household rows is no longer written for new
applications and is kept for history.

**Code.**
- Add the standing derivation and `settleHouseholdBg` (`src/lib/membership/`).
- Have `attest`, `boardResetReview`, `switchRejectionToApprove` and the merge call
  `settleHouseholdBg` after a `PERSON_BG` outcome.
- `namedSubject` moves to the `PERSON_BG` first decision. It validates against the
  requested household's live leads and runs on a rejection as well as an approval.
  `establishedSubject` and the household branch of `clearingApprovals` go, because
  the subject lives on the review row once named. `mergeBgAdvance.ts` goes entirely.
- `householdBgIsFresh` becomes the qualifies predicate, for every caller in §1.3.

**Routes.**
- `GET /api/membership/reviews`: every item is a check review. One with a subject
  shows the person and their household; one without shows the requested household
  and its leads to pick from, as today. This is a response-shape change on a
  registered route.
- `POST /api/membership/reviews`: `subjectPersonIds` is required on the first
  decision of a review with no subject, for a rejection as well as an approval. It
  is refused on a review that already has one.
- `review-override`: resets a check review. On a review opened by consent, the
  reset also clears its subject. Household rows are no longer reset.
- `bg-consent` and the Board's external mark: consent opens or reuses the
  household's unnamed review. It names no person (PBR-7).
- Merge analyze: `mergeBgNotice` is replaced by the dispute refusal preview (§6).
- New: the Board's release of a household from a departed person's rejection (§3.4).
  It is a new mutating route; whether it goes through the registry is decided with
  PR 3.

**UI.**
- Review page: the "whose report did you read" picker stays for a review with no
  subject, and now shows on reject too. A review with a subject shows the person
  and their household, with no picker.
- Applications page: a blocked application shows whose review blocked it, and
  progress counts the check review. A blocked application whose rejected person has left offers
  the Board's release.
- Applicant `/membership` page: unchanged. The family is not asked whose check it
  is.

**Notifications.** No new templates. `membership.reviewNeeded` is unchanged. The
`paymentOpen` / `paymentOpenExistingCheck` choice follows whether a review just
cleared or the household already qualified. `board.paidReject` fires when a person's
rejection blocks a paid application.

**Reports.**
- Compliance STALE_BG uses the predicate, so a household with a disputed adult is
  reported stale.
- A new per-person bucket, `BG_DISPUTED`, lists people with a disputed check.
- The blanket-stamp bucket stays, because it reports legacy data.
- The attestation audit page shows household-era rows under their named subject
  where one exists.

---

## 5. Migration of live data

The approach is a one-step cutover with no legacy path (owner, 2026-11-07: the
volume is one or two items, so redoing them is cheaper than keeping one-off code).
New code never reads a household row's attestations. Each in-flight household
review restarts as an ordinary check review with no subject, and two reviewers
review it again. No migration file is written, no row is copied or rewritten, and
no audit row is touched. The old attestations stay on their household rows as
history.

### 5.1 First, count

A read-only query, run by someone with database access before PR 4 ships:

```sql
SELECT p.status,
       count(*)                                            AS rows,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "BackgroundCheckAttestation" a
                          WHERE a."processId" = p.id))     AS with_attestations
FROM "OrgMembershipProcess" p
WHERE p.kind IN ('INITIAL','RENEWAL') AND p."bgClearedAt" IS NULL
  AND p.status NOT IN ('ACTIVE','ARCHIVED')
GROUP BY p.status;
```

The count tells the Board how many reviews will be asked for again. Review volume
is low (`docs/rules/principles.md`, Assumptions).

### 5.2 What happens to each class of row

| Live household row | Disposition | History |
|---|---|---|
| Cleared (any era) | Nothing. Its named subject already carries `lastBackgroundCheck`. | Attestations stay on the row; audit unchanged. |
| Cleared with blanket stamps (no subject) | Nothing. The compliance blanket-stamp bucket keeps reporting it (PBR-8). | Unchanged. |
| Waiting on its check, consent recorded, with or without approvals | `settleHouseholdBg` finds an application with consent and no check review for its household. It opens one with no subject, the same rule that serves every new application. Any earlier approvals count for nothing and stay on the household row. | Old attestations stay on the household row. |
| Waiting on its check, no consent yet | Nothing. Its consent opens a check review when it is recorded, as for any new application. | Unchanged. |
| `BLOCKED` | None exist today. Cutover precondition: the §5.1 query shows no `BLOCKED` household row. One that appears before cutover is reset by the Board on today's code first, so no household-level block code survives. | The reset's audit row keeps the rejection. |

No code is written for the cutover alone. The opener in the third row is the
general rule, and it runs for new and old applications alike.

### 5.3 Order

1. **Expand** (PRs 1, 2, 3a): add the derivations, the merge refusal and the
   column. All of it is additive and reads today's data.
2. **Check** the §5.1 query: no `BLOCKED` household rows.
3. **Cut over** (PR 4): the queue lists only check reviews, and `settleHouseholdBg`
   opens reviews for applications waiting on one. During the rolling deploy's
   drain window, old code may record a household attestation; new code ignores it.
   The worst result is one more re-review, which the Board accepts.
4. **Switch readers** (PR 5): intake, renewal, compliance and merge use the
   predicate.

No column is dropped, so no contract release follows.

### 5.4 What the three gaps mean for live data

As of 2026-11-07 no review in production is rejected, so two of the gaps have no
live rows: no household contains a disputed adult, and no rejection lacks a
person.

**One lead, two reviews** can exist live. Both cleared needs no action: the later
date stands. If both are open, the household's review restarts with no subject
(§5.2). When its first reviewer names the lead, the PBR-11 rule applies. If the
lead's own review has decisions on it, the naming is refused and the reviewer
reviews the lead there. If it has none, it is closed with an audit row. Either way
the lead ends with one review, and no cutover code is needed for it.

## 6. Person merges in the new model

All check state lives on people, so a merge has one question to answer: does it
change a check fact about a person whose check is disputed?

**Refusal (owner ruling 2026-11-07).** A merge is refused while either record is
`DISPUTED` and the merge would change that human's check facts: the carried
`lastBackgroundCheck`, or a second review re-pointed onto them. The refusal names
the disputed review and says the Board settles it first (reset, then two
approvals, or the rejection stands and the merge proceeds without changing check
facts). A person is disputed through their own `BLOCKED` `PERSON_BG`. Until PR 4
ships, a `BLOCKED` household row also disputes every lead of its household, because
it names nobody. None exist today, so this matters only if one appears. This
refusal can ship before anything else (PR 2), because it reads only today's data.

**What a merge does otherwise.**
- It carries the newer date, as today.
- It re-points reviews and attestations, keeping today's three collision refusals
  and the duplicate-`PERSON_BG` archive.
- Then it runs `settleHouseholdBg` for both households. That one call replaces
  `advanceHouseholdBgAfterMerge`, along with its "was fresh before the merge" flag
  and its search for a past Board reset in the audit log. A reset person is disputed
  until two approvals land, and a merge is refused while they are disputed, so a
  carried date can never stand in for a reset. That is the 2026-10-30 rule,
  enforced by construction.

**Session actors only.** As today, the post-merge settle runs only for a session
actor, behind the own-household guard (`execute.ts:228-230`).

---

## 7. PR sequence

Each PR is one kind and is based on `main`.

| # | Kind | Contents | Depends on |
|---|---|---|---|
| 1 | Code | Check standing + qualifies predicate + `settleHouseholdBg`, unused, with unit tests | none |
| 2 | Code | Merge refusal on a disputed check (owner ruling), reading today's rows | 1 |
| 3 | Security boundary, alone | Registry change for `GET /api/membership/reviews`, if its returned models or fields change. Re-check which other routes are registered first | none |
| 3a | Schema | Add `requestedForHouseholdId` (nullable, `@sensitivity` annotation, regenerated classifications), unused | none |
| 4 | Code | Consent opens a check review with no subject; first decision names the person (approve or reject); the queue lists check reviews; review outcomes call settle; household attestations no longer read; household attest path, `establishedSubject` and the household arm of `awaitingBgReview` removed. Cutover precondition §5.3 step 2 | 1, 3, 3a |
| 5 | Code | Intake, renewal and compliance switch to the predicate; merge calls settle; `mergeBgAdvance.ts` removed; `BG_DISPUTED` bucket | 4 |
| 5a | Code | Board "release" of a household from a departed person's rejection (§3.4, PBR-9) | 4 |
| 6 | Docs | `docs/rules/membership.md` and `people-households.md` wording (§3.3); delete this file | 5, 5a |

One additive schema PR (3a); no data migration and no destructive change.

---

## 8. Owner questions

IDs are stable. Every question is decided.

### Decided (owner, 2026-11-07)

- **PBR-1.** (a): a rejection of any adult in the household counts against the
  household. The intended outcome is that the Board denies the family; the app
  raises the case and doesn't decide it (PBR-13).
- **PBR-13.** (a): hold and raise. While an adult in the household is disputed,
  its open application can't clear or activate. The Board gets the queue item and
  the email and decides whether to deny. Nothing is taken from a membership that
  is already active.
- **PBR-2.** A rejection mid-year in an ACTIVE household triggers nothing
  automatic. It goes to the Board's queue with an email.
- **PBR-3.** One cleared lead is the household's gate. Other adults stay warn-only
  obligations.
- **PBR-4.** No household-level block code is kept. None exist today, and one that
  appears before cutover is reset on today's code (§5.2, §5.3).
- **PBR-5.** A merge is refused only when it would change a disputed person's check
  facts (§6).
- **PBR-6.** In-flight household reviews restart and are reviewed again. There is
  no drain path (§5).
- **PBR-11.** (a): naming a person whose own review has attestations or is blocked
  is refused; an empty one is closed with an audit row.
- **PBR-12.** (a): a reviewer who thinks the wrong person was named asks the Board
  to reset, which clears the subject.
- **PBR-7.** The first reviewer's decision sets whose check the review is about.
  Consent never names a person (§3.1).
- **PBR-8.** Legacy blanket-stamped clearances are left as they are.
- **PBR-9.** A dispute follows the person. The Board can release the household the
  person left, for example after a divorce (§3.4).
- **PBR-10.** Superseded by PBR-11. With no drain, a household review never clears
  beside an open review of the same lead.

## Appendix: alternatives considered

- **A new `BackgroundCheckReview` table.** Rejected. `PERSON_BG` already has every
  field and transition a person review needs. A new table would mean a data
  migration of live rows and a security-boundary binding for a new model, and it
  would buy nothing.
- **Set `subjectPersonId` on household rows**, making each application the review of
  its named lead. Rejected, because it keeps the application and the judgment in one
  row: the conflation this design removes.
- **Copy live household attestations onto new person rows at cutover.** Rejected.
  Each copied approval would appear twice in the audit page and in the reviewer's
  own history, and the audit log's references to the original rows would point at
  rows that no longer decide anything.
