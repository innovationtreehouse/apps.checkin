# Person-based background-check review

## Answer

Yes. Background-check review should be per person, and a household's eligibility
should be computed from its people's checks.

The most serious result of today's design is a gap against Policy. Membership
Policy, Art. IX, says nobody whose check fails may be a member. In the app, an
adult whose own check was rejected stays in a member household. The household
then renews without any new review, as long as another lead's check is still
valid. This is live behaviour, not a theory. PBR-1 asks the owner to close it and
offers an interim guard that can ship before the redesign does (§8).

The cause is that the app reviews checks in two ways that store the same facts
differently. A household application's review names one adult. A per-person
review covers everyone else. Each has its own rejection and its own Board reset,
and the two never consult each other. That is also why one lead can be under two
separate reviews of the same report at once, and why a household rejection
doesn't record whose check failed.

The move is cheap because the per-person review already exists and already does
everything a review needs: two independent approvals, rejection, reset, change to
approve, undo, consent and the reviewer queue. The proposal makes it the only kind
of review. A household application stops holding attestations and instead asks one
derived question: *does at least one lead hold a valid clearance, and does no adult
in the household hold a standing rejection?* No table is added or dropped. Live
household reviews still in progress finish on today's path, and the history they
carry stays where it is.

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
| Reviewers | Every queue card is a person, with their household named for context. No "which adult did you read" picker. | Two independent reviewers, the own-household bar, reject, change to approve, undo. |
| Applying family | The lead who consents is the person whose check is reviewed. Payment and review still run in parallel. | Stepper, payment, agreement. |
| Board | Reset applies to a person's review. A rejection of any adult in a household blocks that household's open application (see PBR-1). | Deny, restore, grant, close, refund. |
| Merges | Refused while either side has a disputed check that the merge would change (owner ruling 2026-11-07). The household-only carry-forward code goes away. | Newer date carried, archive kept, no un-merge. |
| Data | No table added or dropped. In-flight household reviews finish on today's path. Legacy rejections keep blocking until reset. | Every attestation and audit row stays. |

Cost: about six small PRs and no schema migration. The largest unknown is how many
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

A **check review** is today's `PERSON_BG` process, unchanged in shape: one subject
person, attestations from two independent reviewers, `BLOCKED` on rejection, reset
and change-to-approve as now. It is the only place a reviewer's judgment is
recorded. A person has at most one review that is open or blocked, which
`personBgOpen` already enforces.

Every way a check gets started opens or reuses the subject's check review:

- A lead consenting during a household application or renewal (new opener; today
  that consent lands on the household row).
- The Board recording an external check (`submitPersonBgForReview`, unchanged).
- The yearly sweep and the new-member trigger (unchanged).

A person's **check standing** is derived from their reviews and their date:

| Standing | Meaning |
|---|---|
| `CLEARED` | `lastBackgroundCheck` inside the window, and no review blocked or reset-and-waiting |
| `DISPUTED` | a review is `BLOCKED`, or was Board-reset or changed-to-approve and has not cleared since |
| `PENDING` | a review is open with consent, nothing disputed |
| `NONE` | none of the above |

`DISPUTED` beats `CLEARED`. A person who holds an old clearance and whose new review
was just rejected is disputed.

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

The application keeps `BLOCKED` as its status, so the Board queues, the payment
refund notice (`board.paidReject`) and every "a household with a blocked
application cannot…" rule keep working unchanged. The difference is that a person's
review writes the status; a household attestation never does.

The intake and renewal shortcut become the same predicate: an application that
qualifies on arrival is stamped exactly as today.

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
  consent opens their own check review".
- *Renewal*: "unless a lead's is still valid at the boundary" gains "and no adult in
  the household is disputed".

In `docs/rules/people-households.md`, the merge bullet on membership standing is
rewritten per §6.

---

## 4. What it changes

**State machines** (`src/lib/membership/lifecycle.ts`).
- `PERSON_BG`: one new entry edge, ∅ → `PENDING_BG_REVIEW` by applicant consent.
  Its other edges are unchanged.
- Household kinds: the edges whose event is `attest REJECT`, `boardResetReview`,
  `attest change to APPROVE` and `clearBackgroundCheck` keep their from/to states,
  but their event becomes `settleHouseholdBg` (system actor, triggered by a person
  review). The legacy `PENDING_BG_REVIEW` household edges stay for drain.
- `awaitingBgReview` loses its household arm once the drain ends. The queue then
  lists only `PERSON_BG`.

**Schema.** None required. `BackgroundCheckAttestation.subjectPersonId` stops being
written on household rows and is kept: it is the record of whose report each
historical approval read. `OrgMembershipProcess.bgConsentAt` on household rows is
no longer written for new applications and is kept for history.
(Skipped: a column linking an application to the review it waits on. The link can
be derived from the household's leads, so a column would only add drift. Add one if
the Board cards need a direct join.)

**Code.**
- Add the standing derivation and `settleHouseholdBg` (`src/lib/membership/`).
- Have `attest`, `boardResetReview`, `switchRejectionToApprove` and the merge call
  `settleHouseholdBg` after a `PERSON_BG` outcome.
- Remove `namedSubject`, `establishedSubject`, `approvalsForSubject`, the household
  branch of `clearingApprovals`, and `mergeBgAdvance.ts` entirely.
- `householdBgIsFresh` becomes the qualifies predicate, for every caller in §1.3.

**Routes.**
- `GET /api/membership/reviews`: every item is a person. The household leads'
  selection for the picker goes. This is a response-shape change on a registered
  route.
- `POST /api/membership/reviews`: `subjectPersonIds` is ignored and then removed.
- `review-override`: resets a person review. The household rows are reset only for
  the legacy case.
- `bg-consent` and the Board's external mark: consent names a person, and a Board
  mark must name the lead (PBR-7).
- Merge analyze: `mergeBgNotice` is replaced by the dispute refusal preview (§6).

**UI.**
- Review page: the picker goes, and the card shows the person and their household.
- Applications page: a blocked application shows whose review blocked it, and
  progress counts the person review.
- Applicant `/membership` page: the consent step names whose check is being
  reviewed. The stepper is unchanged.

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

The approach is expand, drain, contract (`docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
rules 1-3). Nothing is copied or rewritten, so no migration file is needed and no
audit row is touched.

### 5.1 First, count

A read-only query, run by someone with database access before PR 4 ships:

```sql
SELECT p.status,
       count(*)                                            AS rows,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "BackgroundCheckAttestation" a
                          WHERE a."processId" = p.id AND a.result = 'REJECT'))   AS with_reject,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "BackgroundCheckAttestation" a
                          WHERE a."processId" = p.id AND a.result = 'APPROVE'
                          AND a."subjectPersonId" IS NULL))                     AS unnamed_approval,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AuditLog" l
                          WHERE l."tableName" = 'OrgMembershipProcess' AND l."affectedEntityId" = p.id
                          AND l."newData"->>'action' IN ('board reset','rejector changed to approve'))) AS reset_or_switched
FROM "OrgMembershipProcess" p
WHERE p.kind IN ('INITIAL','RENEWAL') AND p."bgClearedAt" IS NULL
  AND p.status NOT IN ('ACTIVE','ARCHIVED')
GROUP BY p.status;
```

Review volume is low (`docs/rules/principles.md`, Assumptions), so I expect single
digits. This is unverified.

### 5.2 What happens to each class of row

| Live household row | Disposition | History |
|---|---|---|
| Cleared (any era) | Nothing. Its named subject already carries `lastBackgroundCheck`. | Attestations stay on the row; audit unchanged. |
| Cleared with blanket stamps (legacy, no subject) | Nothing. The compliance blanket-stamp bucket keeps reporting it (PBR-8). | Unchanged. |
| In review, no attestations | Drains on today's path if consent was already recorded; otherwise, after PR 4, consent opens a person review instead. | Unchanged. |
| In review with approvals, or reset and waiting | Drains on today's path: today's code stays live for these rows until they clear or block. | Unchanged. |
| `BLOCKED` (standing rejection, no subject) | Stays a household-level block. It keeps blocking its household and keeps today's Board reset. A reset of it sends the application to the new path (PBR-4). | Unchanged. |

The app makes no inference about whose check a legacy rejection was about. Guessing
would fail closed in the wrong direction (`docs/rules/principles.md`, Fail closed).

### 5.3 Order

1. **Expand** (PRs 1-2): add the derivations and the merge refusal. They are
   additive and read today's data.
2. **Cut over** (PRs 4-5): new consent opens person reviews, and the predicate
   replaces the shortcut. Old code serving during the drain window still writes
   only household rows that the new code also reads, so nothing old code writes is
   lost.
3. **Drain**: re-run the §5.1 query until only `BLOCKED` household rows remain.
4. **Contract** (PR 7): remove the household attest path and `mergeBgAdvance`. No
   column is dropped, so no destructive migration follows.

### 5.4 What the three gaps mean for live data

Each gap in §2 may already be present in the live database. Each needs counting
before cutover, because the new rules will act on whatever is there.

**Rejected adult in a member household (Art. IX).** Some ACTIVE households may
already contain an adult with a `BLOCKED` `PERSON_BG`. Under the new rules that
adult is `DISPUTED`. So once PR 5 ships, the household's next renewal blocks
instead of renewing on the shortcut. Nothing happens to the membership before
then (PBR-2). The Board should see the list before the change, not discover it at
renewal time:

```sql
SELECT h.id AS household_id, p.id AS person_id, b.id AS blocked_review_id
FROM "OrgMembershipProcess" b
JOIN "Person" p ON p.id = b."subjectPersonId"
JOIN "Household" h ON h.id = p."householdId"
JOIN "OrgMembership" m ON m."householdId" = h.id
WHERE b.kind = 'PERSON_BG' AND b.status = 'BLOCKED' AND m.status = 'ACTIVE';
```

**One lead, two reviews.** Some leads may have both a household review naming them
and a `PERSON_BG` of their own, open or decided. Three cases follow:

- *Both open.* The household row drains on today's path. If it clears, it stamps
  the lead's date and leaves their `PERSON_BG` open, and nothing closes that row
  today. The new code must not count it as a second open review. The Board closes
  it (close application, with a reason), or the drain closes it with an audit row
  naming the household clearance (PBR-10).
- *One cleared, one blocked.* The new derivation reads the person as `DISPUTED`,
  because a blocked review outranks a clearance. That is the stricter reading,
  and it is correct: two reviewers did reject. But it changes the household's
  standing on the day PR 5 ships, so these rows go on the Board's list above.
- *Both cleared.* No action. The later date already stands.

Count the cases with the §5.1 query joined to `PERSON_BG` rows on the household's
leads; nothing about them can be inferred.

**Rejections that name nobody.** A live `BLOCKED` household row records no person.
It stays a household-level block (PBR-4), and two consequences follow:

- *Merges.* The PR 2 refusal must treat that row as disputing **every** lead of
  its household, because the app can't tell which lead it was about. This is the
  fail-closed reading, and it can refuse a merge of the lead who wasn't rejected.
  The way out is the Board reset.
- *Unnamed approvals.* A row carrying an approval that named nobody already needs a
  Board reset under today's rules. It gets no new treatment, but it can only drain
  through that reset, so it appears in the §5.1 `unnamed_approval` count until
  then.

---

## 6. Person merges in the new model

All check state lives on people, so a merge has one question to answer: does it
change a check fact about a person whose check is disputed?

**Refusal (owner ruling 2026-11-07).** A merge is refused while either record is
`DISPUTED` and the merge would change that human's check facts: the carried
`lastBackgroundCheck`, or a second review re-pointed onto them. The refusal names
the disputed review and says the Board settles it first (reset, then two
approvals, or the rejection stands and the merge proceeds without changing check
facts). Reading people covers both kinds of row today: a person is disputed through
their own `BLOCKED` `PERSON_BG`, and during the drain also through a `BLOCKED`
household row whose household they lead. This refusal can ship before anything else
(PR 2), because it reads only today's data.

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
| 0 | Code, interim | PBR-1 (ii) renewal guard, only if the owner takes it; independent of 1-7 | none |
| 1 | Code | Check standing + qualifies predicate + `settleHouseholdBg`, unused, with unit tests | none |
| 2 | Code | Merge refusal on a disputed check (owner ruling), reading today's rows | 1 |
| 3 | Security boundary, alone | Registry change for `GET /api/membership/reviews`, if its returned models or fields change. Re-check which other routes are registered first | none |
| 4 | Code | Consent opens person reviews, the queue lists person items, review outcomes call settle. Household attest path kept for drain | 1, 3 |
| 5 | Code | Intake, renewal and compliance switch to the predicate; merge calls settle; `BG_DISPUTED` bucket | 4 |
| 6 | Docs | `docs/rules/membership.md` and `people-households.md` wording (§3.3); delete this file | 5 |
| 7 | Code, contract | Remove `namedSubject` and friends, the picker, `mergeBgAdvance.ts`, the household arm of `awaitingBgReview`. Only after §5.1 shows no in-flight household reviews | 5, drain |

No schema PR and no migration PR.

---

## 8. Open questions for the owner

**PBR-1. A rejected adult in a member household (Policy, Membership Art. IX).**
Today an adult whose own check was rejected stays in a member household, and the
household renews on another lead's still-valid check with no new review (§2).
This question has two parts.

*Target rule (with the redesign).* Options: (a) a rejection of any adult in the
household blocks its open application; (b) only a lead's rejection does.
*Recommendation: (a).* Art. IX bars anyone whose check fails from membership, and
membership comes from being in the family, so any adult's failure blocks.

*Interim (before the redesign).* Options:
- **(i) Report only.** The compliance view lists ACTIVE households with an adult
  whose per-person review is blocked (the §5.4 query). Behaviour doesn't change;
  the Board acts by hand.
- **(ii) Renewal guard.** Renewal and intake treat a blocked per-person review on
  any adult in the household as they treat a blocked household application. Renewal
  is refused with today's "with the board" message, and the still-valid-check
  shortcut is not taken. This is one small code PR in `renewal.ts` and `intake.ts`,
  independent of every PR in §7.
- **(iii) Nothing** until the redesign lands.

*Recommendation: (i) now, then (ii).* The Board sees today's cases before any
renewal changes under them, and (ii) stops new ones at the next renewal. Neither
acts on a membership already active, so people still decide about people.

**PBR-2. A rejection mid-year in an ACTIVE household.** Should anything happen to
the membership before the next renewal? *Recommendation: no automatic action.* It
goes to the Board's queue with an email, and it blocks the next renewal. People
decide about people (`docs/rules/principles.md`).

**PBR-3. One cleared lead, or every adult?** Policy asks for at least one adult
checked plus any adult 18+ present regularly. *Recommendation: keep one lead as the
gate.* Other adults stay warn-only obligations. Making every adult a gate would
change who can join and is the Board's call.

**PBR-4. Legacy blocked household rows with no named person.** Options: (a) they
keep blocking as household-level blocks until a Board reset; (b) the Board names
the adult, turning each into a person dispute. *Recommendation: (a).* No new
screen, no guessing, and the volume is low.

**PBR-5. How wide is the merge refusal?** Options: (a) refuse any merge where
either side is disputed; (b) refuse only when the merge would change that person's
check facts. *Recommendation: (b).* Under (a), a duplicate record of a person whose
rejection stands could never be merged.

**PBR-6. In-flight household reviews.** Options: drain on today's path, or convert
them to person reviews at cutover. *Recommendation: drain.* No attestation is copied
or rewritten, and the history keeps its original shape.

**PBR-7. Who is checked when the Board marks consent for a household?**
*Recommendation: the Board names the lead.* An unnamed consent is the gap that
produced the named-adult machinery.

**PBR-8. Legacy blanket-stamped clearances.** Some old household clearances stamped
every lead from one review. *Recommendation: leave them.* The compliance bucket
already reports them, and they expire at their next recheck.

**PBR-9. A disputed person moves to another household.** *Recommendation: the
dispute follows the person, and also stays on the application that was open when it
was decided.* A lead can't clear their household by removing a rejected spouse, and
the rejected adult can't join another household cleanly.

---

**PBR-10. A lead's per-person review left open after their household review
cleared.** Options: (a) the Board closes each one by hand; (b) the drain closes it
automatically, with an audit row naming the clearance. *Recommendation: (b).* The
same two-reviewer clearance of the same person already exists, so closing the
duplicate decides nothing new. The audit row keeps the record.

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
