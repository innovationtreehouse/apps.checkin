# Cutover: "check started" moves off the household application

Everything here expires once the change has run. The rules are in
`docs/rules/membership.md` (*Background checks for individual adults*) and
`docs/VOCABULARY.md` (**Consent**, **Check started**).

## Where it stands

"Check started" is recorded on each person's own check review. The household
application no longer records it, and nothing writes the household flag any more.
Open applications in production may still carry it from before the cutover; the
legacy clause below reads them. The Board's close-as-wrong-person waits on a Board
rule amendment (step 2b).

## The legacy clause

Until the exit condition holds, an open INITIAL or RENEWAL application whose own
`bgConsentAt` is set counts as "check started" in three places:

1. **The advance gate.** `householdCheckStarted` also returns true when the open
   application carries the flag.
2. **Where a lifted block resumes.** `blockedResetStatus` gets the same derived
   `true`.
3. **Settle and the daily sweep.** These still open a review naming nobody for such
   an application, under today's conditions: no lead cleared or pending, nobody
   disputed, no review already open for the household. This is today's
   `openRequestedReview`, now keyed only on the legacy flag, so a family that
   consented before the cutover is not left with nothing in the queue.

All three read one helper, `legacyHouseholdCheckStarted(app)`, so the follow-up PR
deletes one function and its callers.

**Exit condition.** No open INITIAL or RENEWAL application has `bgConsentAt` set and
`bgClearedAt` null. The System Status page shows the count, in the row
"Applications on the old household check flag"
(`checkin-app/src/lib/membership/legacyCheckFlagHealth.ts`, which reads the open
statuses from `openProcess`). Step 3 can land once it reads 0. Nobody runs a query
against production for this.

Applications clear, finish or are closed in the normal course of things. A few
stuck ones are a Board conversation, not a reason to keep the clause.

## Pull requests, in order

No PR is stacked on another. Each is based on `main` after the one before it has
merged. Confirm a merged PR's files are on `main` (`git show origin/main:<path>`)
before starting the next. Steps 1 (the boundary PR) and 2 (the app build) have
merged.

2b. **App: the Board's close-as-wrong-person, after the Board adopts the B5/B25
   amendment.** Based on `main` after step 2. Before that, it waits.
   - `closeAsWrongPerson` on `boardResetReview` and the review-override route body.
     There is no boundary change: the route is on the legacy baseline.
   - The Board's button beside the wrong-person reset.
   - In the same PR: apply the amended B5/B25 line and its two procedure lines from
     the draft amendment below to `docs/rules/membership.md`, with the Board's adoption noted
     in the PR body, not in the rule.

   In the same PR, delete the close section and the draft amendment below.
3. **App: drop the legacy clause** once the exit condition holds:
   - Delete `legacyHouseholdCheckStarted` and its three callers.
   - Delete `openRequestedReview`.
   - Narrow the sweep to re-settle only.
   - Delete the System Status row `legacyCheckFlagHealth.ts`, its test and its line in the
     config-health route.
   - Remove the rule sentence about the legacy clause, if one was written.
   - Delete this file.

   No migration: the column and its old values stay as history.

## The Board closes a review opened for the wrong person

**The stranded case.** A review is rejected, but it was opened for the wrong
person: two people with similar names, one of whom never took the check. Two
things then hold the family:

- A Board reset of the BLOCKED review sends it back. The person stays disputed
  until two new approvals, which never come, because there is no check to approve.
- The existing wrong-person reset clears the person off the review. That does free
  the *person*: their standing reads only reviews that name them, so they are no
  longer disputed. But the review now names nobody and still holds the rejection.
  A review that holds a rejection cannot be closed, and the household cannot
  qualify while a review requested for it waits to be named. The *household* is
  stuck instead.

Today nobody can free them without recording approvals that never happened.

**Choice: extend the wrong-person reset rather than add a path.** The Board's
existing reset route (`POST /api/membership-ops/applications/review-override`,
Board only, `boardResetReview` in `checkin-app/src/lib/membership/review.ts`) gains
one option, `closeAsWrongPerson: true`. This is the simpler and safer choice:

- **It already carries every guard this needs.**
  - It is Board only; reviewers cannot reach it.
  - The reason is required.
  - It has the household bar: no actor in the subject's or the requesting household
    (`reviewHouseholds` with `refuseSelfGrant`).
  - It refuses a denied household.
  - It takes the review's row lock, as `attest` does, and writes an audit row.
  - It settles afterwards.

  A separate dismiss path would copy all of that, and two copies drift.
- **The fact belongs where the wrong-person reset already is.** "This review was
  opened for the wrong person" is the Board's existing judgement. Closing the review
  instead of returning it to the queue is a second outcome of the same judgement,
  not a different act.
- **No boundary change.** The route is on the legacy-authz baseline and gains only a
  body field. There is no new route and no registry or classification change.
- **The reviewers' dismissal stays narrow.** It never touches a rejection, so the
  table of allowed and refused states above stays as it is. Everything involving a
  rejection is the Board's, on one route.

**What `closeAsWrongPerson` does:**

- **Where it applies:** any open check review (PENDING_BG_REVIEW or BLOCKED), named
  or not. That includes:
  - a BLOCKED review;
  - a sent-back review;
  - a review left naming nobody, holding a rejection, after an earlier wrong-person
    reset.

  `requestedForHouseholdId` is not required, unlike the plain wrong-person reset.
- **Closes the review as it stands:** ARCHIVED from its current status, with
  `archivedFromStatus` set. Unlike a reset, **it deletes no attestation**. The
  rejection and its note stay on the review's own rows, and the subject stays named
  as the person the review was opened for. The rejection is then on record against
  that review, and never deleted.
- **Writes one audit row** with the actor, the reason and
  `{ action: "closed: opened for the wrong person", status: "ARCHIVED" }`.
- **Settles every household the review touches**, as a reset does. An application
  BLOCKED by this review resumes, because the review is no longer BLOCKED. The
  household qualifies again once a lead holds a clearance.

**Why the rejection stops counting.** A person's standing, the household's
"waiting to be named" test and the hold on closing a review all read only open
reviews (`personBgOpen`: PENDING_BG_REVIEW and BLOCKED). An ARCHIVED review counts
against nobody. The person may be marked again: the mark opens a fresh review with
no history, which needs two approvals like any other. The build PR confirms that no
reader counts a rejection on an ARCHIVED review. A search on `main` finds the
attestation result read only in `attest`.

**Side effect.** If the closed review was one the person already owed (opened by
activation or the yearly sweep), the obligation closes with it. The sweep's daily
run reopens it if the person still needs a check. The obligation is surfaced for
follow-up and gates nothing.

**Pending the Board.** This undoes the effect of a rejection without two
approvals, which Board ruling B5/B25 forbids today. It ships only once the Board has
adopted the amendment below.

### Draft amendment to B5/B25, for the Board — not decided

Needs Board approval. Nothing here is a rule until the Board adopts it.

Current text (`docs/rules/membership.md`, *Application and review*):

> - Nobody clears a blocked application on their own. After a rejection the check
>   needs two approvals again, from two independent reviewers.  [Decision — Board ruling B5/B25]

Proposed:

> - Nobody clears a blocked application on their own. After a rejection the check
>   needs two approvals again, from two independent reviewers, unless the Board
>   records, with a written reason, that the review was opened for the wrong person.
>   That review is then closed with its rejection kept on record against it; the
>   rejection no longer counts against the person it named, and any later check of
>   theirs is reviewed afresh and needs two approvals like any other. No one in the
>   household of the person named, or of the household that asked for the review,
>   may record it.  [Decision — Board ruling B5/B25, as amended]

What it changes, in one sentence: a rejection on a review the Board finds was
opened for the wrong person no longer needs two approvals to stop counting against
that person. Nothing else changes: no rejection is deleted, and no clearance is
granted.

The two procedure lines that follow from it, applied with the amendment and not
before:

> - A check review that still carries a rejection cannot be closed; it needs a
>   decision from two new reviewers, unless the Board closes it as opened for the
>   wrong person.  [Decision]
>
> - A reviewer who believes the named person is wrong asks the Board for a
>   wrong-person reset, which returns the review to no person, or closes it when it
>   was opened for the wrong person altogether. The person cleared off a returned
>   review keeps any rejection it held, and naming them again brings it back; a
>   closed review keeps its rejection on record and counts against nobody.  [Decision]

### Tests for step 2b

- Board only: a reviewer is refused at the route.
- The household bar and the denied-household refusal apply.
- It works from BLOCKED, from a sent-back review, and from an unnamed review
  holding a rejection.
- Attestations are kept and the review is ARCHIVED, with one audit row.
- The person is no longer disputed, and the blocked application resumes.
- A new mark opens a fresh review needing two approvals.
