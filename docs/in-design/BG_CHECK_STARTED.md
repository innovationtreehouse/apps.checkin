# Background check "started" is recorded on the person

The one-time cutover (data in flight, PR order, where the rule text lands) is in
`BG_CHECK_STARTED-migration.md`. This file holds only the design and the text that
outlives the change.

## Problem

A background check happens in an outside tool. The applicant gives their legal
consent there, and the result comes back by hand. The app records one fact about
that step: *this check has been started outside, so put its review in the
reviewers' queue.*

The app calls that fact "consent", which it is not. It records it in two places:

- **On the family's application.** A household lead clicks "I submitted my consent".
  The click is about the family, not about any one adult.
- **On one adult's own check review.** An adult who already has a check review of
  their own clicks the same button for themselves.

Everything else about background checks moved to the person: the review, the
decision, the clearance and the rejection. This flag did not. Three problems follow:

- **A second lead can be stuck.** On a renewal both leads may owe a check. After the
  first lead's click, the second lead's click goes to the family's application,
  which is already marked, so nothing is recorded for them. Their check waits until
  the agreement is signed or the Board steps in.
- **A lead cannot record a check for another adult in the family.** The rules say a
  household lead may record that an adult child's check exists. Only the Board and
  sysadmins can do that today.
- **The word misleads.** A reader of the Board's applications page or of the rules
  takes "consent received" for legal consent, which the app never sees.

## Objective

- "Check started" is recorded only on the adult whose check it is. A family's
  application never records it.
- An adult may mark their own check started. A household lead may mark it for any
  adult in their household, at any time. The Board and sysadmins may mark it for
  anyone.
- The app and the rules say "check started", never "consent", for this fact.
  "Consent" is kept only for the act in the outside tool.
- A check review opened by mistake can be dismissed before any reviewer has
  decided on it. Dismissal is not a decision and never stands in for a rejection.
- Membership is unchanged. The application still finishes only once a lead holds a
  valid clearance. Starting a check only puts a review in the queue.
- No data is dropped and no schema changes.

## Executive summary

**Families.** /membership shows one "Background checks" panel. An adult sees their
own check and can mark it started. A household lead also sees the household's
other adults, each showing only "needs marking" or "nothing to do", with a "Mark
check started" button on the first. A mark made by mistake can be dismissed until a
reviewer has decided on the review. The
agreement step no longer carries a consent checkbox. Once the agreement is signed
and a lead's check is started (or a lead is already cleared), the application moves
on to payment as it does today.

**Reviewers.** Every check review opened from now on names its person. The reviewer
confirms the report is that person's. If it is not, the reviewer asks the Board for
the existing wrong-person reset. Reviews that already name nobody (opened before
this change, or returned by a reset) work exactly as they do now.

**Board.** The applications page loses "Confirm BG consent". It gains "Mark a
lead's check started", which picks a lead. The Board's existing per-person submit
is the way to mark anyone else. Neither path has an own-household guard. The Board
can dismiss a review opened by mistake, subject to CS-4.

**What deliberately does not change:**

- The clearance rule: two approvals from reviewers outside the person's household,
  and nobody approves their own check.
- The review, naming, reset, release and blocking machinery.
- The payment-in-parallel flow.
- The compliance view, which still reads the old audit rows.

**Cost:** one boundary PR (a new registered route, three verbs), one app PR, and one small
follow-up PR once the old in-flight applications have drained. No migration.

## Owner rulings this design builds on (2026-11-13)

- **D1** `[Decision — owner]` Check started moves entirely to each person's own
  review. The household application stops recording it. This is what the retired
  person-based design said in its §Schema (`ae095a1c5^`, "no longer written for new
  applications"), though its own walkthrough still had the household's consent open
  the review.
- **Rename** `[Decision — owner]` "Consent" becomes "check started" in the app and
  the rules.
- **D2** `[Decision — owner]` No rule change to clearance. Membership still needs a
  lead's valid clearance before the application can finish. Check started never
  satisfies membership.
- **D4** `[Decision — owner]` A person may mark their own check started. A household
  lead may mark it for anyone in their household. The Board and sysadmins may mark
  it for anyone.
- **D5** `[Decision — owner]` No own-household guard on marking a check started. It
  carries no security weight. The guard stays on approval: two approvals by people
  outside the subject's household, and nobody approves their own check.
- **D3** (household mark limited to leads) is moot: there is no household mark.
- **CS-1** `[Decision — owner]` A person whose age is unknown may be marked. Only a
  known minor is refused.
- **CS-2** `[Decision — owner]` For another adult, a household lead sees only "needs
  marking" or "nothing to do", never their clearance, review or decisions.
- **CS-3** `[Decision — owner]` A family may mark any adult in their household, at
  any time; the Board may mark anyone. There must be a way to dismiss a review
  opened by mistake. Who may dismiss is open question **CS-4**.

These close the open question in PR2779-F02 (the #2779 rule was never ruled on) by
replacing that rule's text. They also close the remainder of PR2779-F03 (a second
lead cannot record their own check while the agreement is unsigned).

## Domain rules this relies on or changes

`docs/rules/membership.md`:

- **Relies on, unchanged:**
  - "A household qualifies on its background check when at least one lead holds a
    valid clearance, …"
  - The two-approval and conflict rules under *Approving your own family*.
  - The wrong-person reset.
- **Changes:**
  - *Application and review*, "A check review is about one person."
  - *Activation*, "Nothing advances toward payment until …"
  - *Background checks for individual adults*, the two rules on recording an
    adult's check, plus new rules on dismissal.

`docs/VOCABULARY.md`: the **Consent** row.

`docs/rules/principles.md`, *Capture a fact where it is known*. The person who
marks a check started knows whose check it is: they took it, or they started it for
a family member. The reviewer holds the report and confirms it. Nobody is asked to
remember a fact someone else holds.

## Design

### The fact and its column

The column `OrgMembershipProcess.bgConsentAt` keeps its name. Renaming a column is
an expand/contract migration for no behaviour. Its schema comment is reworded to say
what it means: *the check has been started outside, so the review is in the
reviewers' queue.*

From this change on, it is written only on PERSON_BG rows. INITIAL and RENEWAL rows
keep whatever value they already hold, and nothing writes one again. The function
`markBgConsent` is renamed `markCheckStarted` and loses its `"household"` branch.

### Marking a check started

One service function, `markCheckStarted(subjectPersonId, actorId)`:

1. **Authorise.**
   - The actor is the subject.
   - Or the actor is a household lead in the subject's household.
   - Or the actor is a sysadmin or Board member.

   There is no own-household guard (D5). A sysadmin who is a family member but not
   a lead marks only themselves through the family path, and anyone through the
   Board path.
2. **Refuse a known minor.** "A person under 18 is never checked." A person whose
   age is unknown may be marked (CS-1). Nothing else is refused (CS-3): not a
   person with a valid clearance, who may be starting the next one before it runs
   out, and not a person whose household has no application under way.
3. **Open or reuse the person's review** under the Person row lock that
   `openPersonBg` already takes, so two marks never open two reviews:
   - **Reuse** the person's open review (PENDING_BG_REVIEW) if there is one. It may
     have been opened by activation or the yearly sweep.
   - **Otherwise create** one, with `subjectPersonId` set and
     `requestedForHouseholdId` set to the person's household.

   This step does not go through the yearly sweep's "is a check needed" verdict. A
   check someone has actually started is reviewed even when the re-check policy is
   unset, as household consent allowed until now. When a reused review has no
   `requestedForHouseholdId`, the mark fills it in, so a later wrong-person reset
   leaves a review the household still owns.
4. **Stamp `bgConsentAt`** once, with a conditional write, and write one audit row
   with the actor. The audit row reads `{ checkStarted: true }`; the compliance view
   still matches the old `{ bgConsentAt: true }` rows.
5. **Notify the reviewers** on the first stamp only, as `submitPersonBgForReview`
   does today.
6. **Settle the subject's household and run the advance gate** on its open
   application. Settle opens no review (below). The gate may now pass.

`submitPersonBgForReview` (the Board's submit) becomes a thin caller of
`markCheckStarted`, which now opens the review itself. The
self-report path (`selfRecordBgConsent`, `selfAttestPersonBg`,
`householdConsentTarget`, `canConsentForHousehold`) is deleted.

### Dismissing a review opened by mistake

One service function, `dismissCheckStarted(subjectPersonId, actorId, reason)`, for
a mark made on the wrong person or for a check that was never started.

**When it is allowed.** Only on the person's open check review, at
PENDING_BG_REVIEW with the flag set, and only while **no reviewer has ever recorded
a decision on it**. A decision since undone, or one discarded by a Board reset,
still counts: the review's attestation audit rows are read, not only its current
attestations. A BLOCKED review, a review carrying or ever carrying a rejection, and
a cleared review are all refused. Dismissal therefore can never stand in for a
rejection: once a reviewer has looked and decided, the review goes through the
existing paths (approval, rejection, wrong-person reset, Board reset) and nothing
else. Before any decision, nobody has judged anything, so there is nothing for a
dismissal to hide.

A written reason is required. The work runs under the review's row lock, the same
lock `attest` takes, so a dismissal and a first decision cannot both land.

**What it does.** It undoes the mark, and only the mark:

- **The mark created the review** (its CREATE audit row is the mark's): the review
  is closed, ARCHIVED from PENDING_BG_REVIEW, as settle already closes unneeded
  reviews.
- **The review existed before the mark**, opened by activation or the yearly sweep
  because the person owes a check: only the flag is cleared. The review leaves the
  reviewers' queue and the owed check stays open, as it was before the mark.
- **A legacy review naming nobody** with no decision on it is closed. Its household
  stands for the subject when deciding who may dismiss.

One audit row is written with the actor, the reason and
`{ checkStarted: false, action: "dismissed: opened by mistake" }`. The mark's own
audit row stays, so the trail shows both.

**What it does not do.** A dismissal is not a decision about anyone. It neither
counts toward nor against membership:

- It records no approval and no rejection.
- It disputes nobody and blocks nothing.
- It clears nothing.

The person's standing simply goes back to what it was before the mark. Settle then
runs for the household. An application that already moved on to payment because of
the dismissed mark stays where it is: payment runs in parallel with the check, and
activation still needs a lead's clearance, which a dismissed mark never gave. The
person may be marked again at any time.

**Who may dismiss** is open question **CS-4**. The service takes the answer as one
`mayDismiss(actor, subject)` check, so whichever option is chosen is a single
function.

### How a family's first check now starts

Every review opened from now on names its person. Settle no longer opens a review
naming nobody off the household flag: `openRequestedReview` is reached only by the
legacy clause in the migration file, and goes when that clause goes.

The rule that the reviewer names the person "where it is known" still holds, at a
different point:

- The marker states whose check was started, which they know.
- The reviewer reads the report and confirms it matches.
- If it does not match, the existing wrong-person reset returns the review to no
  person, and the next decision names the right one.

This departs from the retired person-based design (`ae095a1c5^`, its "Applying
family" row: "nobody assumes the consenting lead is the person checked"). That
objection was to a household click naming whoever clicked, who is often not the
person checked. Here the marker picks the person, and the panel
defaults to "you" only on the marker's own row. The other reason for reviews naming
nobody was that a family with no review had nowhere to record the fact. That is
gone: marking a check started opens the review.

Reviews already open that name nobody, and reviews returned to no person by a
reset, keep today's behaviour:

- The first decider names a lead.
- Settle closes the review once a lead clears without it.
- The household does not qualify while such a review waits to be named.

### What each reader and writer of the household flag becomes

| Where | Today | Becomes |
|---|---|---|
| `markBgConsent` household branch (`checkin-app/src/lib/membership/external.ts`) | Writes `bgConsentAt` on INITIAL/RENEWAL, then settles | Deleted. `markCheckStarted` writes only PERSON_BG. |
| Applicant self-report `POST /api/membership/bg-consent` (`selfRecordBgConsent`) | A lead's click goes to the household application while it waits at the agreement step | Route deleted; its legacy-authz baseline line goes with it. Replaced by `POST /api/membership/check-started` (below). |
| Board `mark-bg-consent` action (`checkin-app/src/app/api/membership-ops/applications/external/route.ts`) | Marks the household application, own-household guarded | Action removed. The page's new "Mark a lead's check started" calls the Board submit `POST /api/membership-audit/person-bg` with the chosen lead's id. The other actions on this route keep their guard. |
| Board submit `POST /api/membership-audit/person-bg` | Sysadmin/Board, any person | Unchanged route; now calls `markCheckStarted`. |
| Dev mock `POST /api/dev/bg-consent/complete` | Any household member marks the household application | Marks the caller's own check started. Still 404 unless the mock is on. The mock page keeps the word "consent": it stands in for the outside tool, where consent is real. |
| Settle opening a review naming nobody (`openRequestedReview` in `checkin-app/src/lib/membership/settleHouseholdBg.ts`) | Opens one when the household application has the flag and no lead is cleared or pending | Not opened for new applications. Legacy clause only (migration file). |
| Daily settle sweep (`settleApplicationsAwaitingCheck`) | Selects open applications with the flag and no clearance | Selects open applications with no clearance. It still re-settles, and opens nothing except under the legacy clause. |
| Advance to payment gate (`advanceExternalIfComplete`) | Agreement signed and (household cleared or household flag) | Agreement signed and (household cleared, **or** a lead's check started, **or** an open review requested for the household that names nobody). The condition is read from people in one shared helper, `householdCheckStarted(db, householdId)`, and the conditional update keeps its status guard. A started check for a non-lead adult does not advance the application: only a lead's clearance qualifies the household. |
| Where a lifted block resumes (`blockedResetStatus` in `checkin-app/src/lib/membership/review.ts`, also used by `resumeStatus`) | Back to the agreement step when the household flag or the agreement is missing | Takes `checkStarted: boolean` from `householdCheckStarted` instead of reading the flag. Callers already hold the household id. |
| Pending standing (`checkStanding` in `checkin-app/src/lib/membership/checkStanding.ts`) | A person is PENDING when one of their reviews has the flag | Unchanged: already per person. |
| Reviewer queue (`awaitingBgReview` in `checkin-app/src/lib/membership/lifecycle.ts`) | PERSON_BG at PENDING_BG_REVIEW with the flag | Unchanged: already per person. Its comment, which today reads "with consent recorded", is reworded to "with the check started". |
| Applicant status (`getExternalStatus`) | `bgConsented` from the household flag | `checkStarted` from `householdCheckStarted`. The agreement-step panel shows "Background check started" as done or not done, and points to the Background checks panel. |
| /membership panels (`ExternalActionPanel`, `OwnBackgroundCheckPanel`, `useMembershipPage`) | Consent checkbox on the agreement step; a separate own-check panel when no household target exists | One "Background checks" panel (below). The checkbox on the agreement step goes. |
| Board applications page (`checkin-app/src/app/membership-ops/applications/page.tsx`) | "Background-check consent ✓ Received / Confirm BG consent", and "waiting on the household's check review" keyed on the household flag | "Background check started" is derived on the page from rows the route already returns: an open PERSON_BG with the flag whose person is one of the household's leads, or one requested for the household that names nobody. The legacy flag also counts while it remains. The button becomes "Mark a lead's check started" with a lead picker. The route's select is unchanged. |
| Intake and renewal pre-marks (`checkin-app/src/lib/membership/intake.ts`, `checkin-app/src/lib/membership/renewal.ts`) | The Board pre-marks the household flag on the INTAKE row, and the arrival re-runs the advance | The Board marks a lead's check started on the person, at any time. The re-run of the advance on arrival stays: a lead may already be started. Only the comments change. |
| Lifecycle drift check (`checkin-app/src/lib/lifecycleDrift.ts`) | Reads the flag into `validateMembership`, which holds no invariant on it | Unchanged. |
| Compliance view, blanket-stamp rows (`checkin-app/src/app/api/membership-audit/compliance/route.ts`) | Reads old household `{ bgConsentAt: true }` audit rows to label who consented | Unchanged. These are historical clearances; new marks are on named reviews, which that query excludes. |
| Person merge ranking (`checkin-app/src/lib/person/merge/execute.ts`) | Ranks a person's open reviews by the flag | Unchanged: per person. |
| Background-check provider (`getConsentDeepLink`) | The outside tool's consent link | Unchanged. That one is real consent. |

### The family path: route, page, who sees whom

**Route.** One new registered path under `handler()`, with three verbs:

- `GET /api/membership/check-started` returns the rows the caller may act on.
  - The caller's own row, always.
  - For a household lead, one row for each other member of their household who is
    not a known minor.

  Each row carries `personId`, `name` and `state` (CS-2):
  - `NEEDS_MARKING`: no open or blocked review of theirs has the flag, and they
    hold no clearance still valid at the next membership-year boundary.
  - `NOTHING_TO_DO`: anything else.

  Rows also carry `mayDismiss`: true when a dismissal is allowed (above) and the
  caller may dismiss (CS-4). The caller's own row may also carry the detail the
  own-check panel shows today.
- `POST /api/membership/check-started`, with body `{ personId }`, calls
  `markCheckStarted` for any adult the caller may mark, whatever the row's state
  (CS-3). It returns the refreshed rows.
- `DELETE /api/membership/check-started`, with body `{ personId, reason }`, calls
  `dismissCheckStarted`. It returns the refreshed rows. The Board and sysadmins use
  the same verb, from the Board applications page and the reviewer queue, for
  whomever CS-4 lets them dismiss.

All three verbs land in the registry first, in their own boundary PR based on `main` (see the
migration file). `state` and `mayDismiss` are synthetic fields; their tier is set in
that PR.

**Who sees whom (CS-2).** For another adult, a lead sees only "needs marking" or
"nothing to do". "Started", "already cleared" and "rejected" all show as "nothing to
do". A lead never sees another
adult's clearance date, review status or decisions: "The check itself … stays
between the person checked, the authorised reviewers, and the board." An adult
sees their own row as today.

**Page.** The panel replaces `OwnBackgroundCheckPanel` on /membership. It shows
whenever the GET returns a row. Each `NEEDS_MARKING` row has:

- The outside tool's link.
- The checkbox "I've started this check in the background-check tool" (on the
  caller's own row: "I've started my check …").
- A "Mark check started" button.

A row with `mayDismiss` also has "Opened by mistake? Dismiss", which asks for a
reason. A lead can be offered this for another adult even when the row reads
"nothing to do". The button shows only the action, never the review's state.

There is no new page and no nav entry.

### Wording

"Consent" is kept only for the act in the outside tool: its consent form and its
link. Everywhere the app recorded the fact, the wording becomes "check started".

| Where | Now | Becomes |
|---|---|---|
| /membership agreement step | "I submitted my consent on Averity" | Removed; status line "Background check started ✓ / not yet". |
| /membership own and family panel | "I submitted my consent on Averity", "Your consent is recorded" | "I've started my check in the background-check tool", "Your check is marked started. The reviewers take it from here." |
| /membership errors | "Could not record your consent", "Only a household lead can confirm background-check consent" | "Could not mark the check started", "Only a household lead can mark another person's check started" |
| Board applications page | "Background-check consent", "✓ Received", "Confirm BG consent", "You can't confirm your own household's contract or consent" | "Background check started", "✓ Started", "Mark a lead's check started"; the own-household note keeps "contract" only. |
| Dev mock page | "Consent" button | Unchanged (it stands in for the outside tool). |
| /membership panel, Board applications page, reviewer queue | — | New: "Opened by mistake? Dismiss" and "Dismissed: the check is no longer marked started." |

### Rule text

The replacement lines, written to be copied as they stand.

*Application and review*, replacing "A check review is about one person. …":

> - A check review is about one person, named when the check is marked started;
>   the reviewer confirms the report is that person's and asks the Board for a
>   wrong-person reset when it is not. A review that names nobody — one returned by
>   that reset — is named by whoever decides first, approving or rejecting, as the
>   one household lead whose report they read. A later decision may repeat that
>   person and never names another.  [Decision]

*Activation*, replacing "Nothing advances toward payment until …":

> - Nothing advances toward payment until the agreement is signed and the
>   background check is handled — either a lead's still-valid clearance, or a
>   lead's check marked started, or a review the household asked for still waiting
>   to be named. A check started for any other adult does not advance it.  [Decision — *Policy: Membership Policy, Art. III §III.1; Art. VI §VI.1*]

*Background checks for individual adults*, replacing the two rules that begin
"A background check for an adult child needs neither …" and "An adult who does sign
in can record their own check …":

> - "Check started" records that a check was started in the outside tool and puts
>   that person's review in the reviewers' queue. It is not consent, which is given
>   in the outside tool, and it approves nothing: membership still needs a lead's
>   clearance by two reviewers.  [Decision]
>
> - It is recorded only on the person whose check it is; a household's application
>   never records it. A person may mark their own; a household lead may mark it for
>   any adult in their household, at any time; the Board and sysadmins may mark it
>   for anyone. A person known to be under 18 is never marked; one whose age is
>   unknown may be. Neither a sign-in nor an email address is needed by the person
>   marked.  [Decision — owner]
>
> - Marking a check started has no own-household bar: it decides nothing. The bar
>   sits on the approvals that clear it.  [Decision — deliberate limit]
>
> - A household lead sees, for each other adult in the household, only whether a
>   check still needs marking — never their clearance, review or decisions.  [Decision — owner; *Policy: Membership Policy, Art. VI §VI.2*]
>
> - A check review opened by mistake may be dismissed, with a written reason, only
>   while no reviewer has ever recorded a decision on it. Dismissal undoes the mark
>   and nothing else: it is not a decision, it approves, rejects, disputes and
>   blocks nothing, and a check the person already owed stays owed. Once a reviewer
>   has decided, only the review's own paths remain.  [Decision — owner]
>
> - [Who may dismiss: not yet decided.]  [Unsettled — owner question CS-4]

The last line is a placeholder, not rule text. It is not extracted as it stands.
Once the owner answers CS-4, it is reworded as a constraint naming who may dismiss,
tagged `[Decision — owner]`, and only then copied.
>
> - The audit names the person who marked it, and the person who dismissed it, so
>   a family's act stays distinguishable from the Board's.  [Decision]

The *Application and review* line "Once a lead is cleared, a review the household
asked for that still names nobody is closed … No review naming nobody is opened for
a household while …" loses its second sentence. No review naming nobody is opened
any more except by the legacy clause, which the migration file owns.

`docs/VOCABULARY.md`, the **Consent** row becomes two:

> | **Consent** | the applicant's act **in the outside background-check tool**. The app never sees or records it | `getConsentDeepLink` | "consent" (only for the tool's form) |
> | **Check started** | someone marked that a person's check was started outside, putting their review in the reviewers' queue. Not consent; approves nothing | `bgConsentAt` (PERSON_BG only), `markCheckStarted` | "check started" |

## Tests

These are named for the build PR. None run for this doc.

- `markCheckStarted`, unit and integration:
  - Who may mark whom, including the Board without a guard and a lead in another
    household refused.
  - A known minor is refused. A person of unknown age, a cleared person and a
    person whose household has no application under way are all accepted.
  - Reuse versus create.
  - `requestedForHouseholdId` is filled.
  - Concurrent marks open one review and write one audit row.
  - Reviewers are notified once.
- `dismissCheckStarted`, unit and integration:
  - Refused once any decision was recorded, including an undone approval and one
    discarded by a Board reset. Refused on a BLOCKED or cleared review.
  - A review the mark created is archived. A review that existed before the mark
    keeps its obligation and only loses the flag.
  - The reason is required. One audit row is written.
  - A dismissal racing a first decision: exactly one lands.
  - Standing, settle and the application status: no dispute, no block, no
    clearance, no status moved back.
  - Who may dismiss, per the CS-4 answer.
- Advance gate:
  - Passes for a lead started and for an unnamed requested review.
  - Does not pass for a non-lead adult started.
  - The legacy clause passes and drains (migration file).
- `blockedResetStatus` and `resumeStatus` with the derived input.
- Settle opens no unnamed review for an application without the legacy flag.
- The F03 renewal scenario: the second lead marks their own check while the
  agreement is unsigned, and their review enters the queue.
- Route contract tests for the three new verbs: field exposure per role. A lead
  sees no clearance date or review state for another adult; `state` has only the
  two values.
- The Board applications page derives "started" from the rows it already has.

## Open questions for the owner

Stable IDs. CS-1 to CS-3 are answered above.

- **CS-4: who may dismiss a check review opened by mistake?** Dismissal is allowed
  only before any reviewer decision, whoever does it.
  - **(a) Whoever may mark it** — the person, a household lead of their household,
    the Board and sysadmins. *Recommended.* It mirrors D4, and a mark carries no
    weight before a decision (D5). The family that made the mistake fixes it
    without asking the Board. Every dismissal is audited with a reason, and the
    person can be marked again at once.
  - **(b) The Board and sysadmins only.** Nothing is removed from the queue
    without the Board, at the cost of a Board request for every slip.
  - **(c) Whoever made the mark, plus the Board and sysadmins.** Narrower than (a):
    the other lead cannot undo their partner's mark.
  - **(d) Any of the above plus background-check reviewers.** *Not recommended.* A
    reviewer who doubts a report must decide or ask for the wrong-person reset.
    Letting the people who decide also dismiss is the one way dismissal could
    become a quiet rejection, even before a decision is recorded.
