# A family leaves the membership

Design for issue #3446, applying Board question B28 ("A family that wants to
leave the membership"), which the Board answered "add this" on 2026-11-17.

## Problem

A family that decides to leave has no way to say so in the app. Only the Board
ends a membership, by revoking it, and the Board only acts when someone tells it
by email or in person. Until then the family is still a member: every year it
gets the renewal emails, and it stays on the member lists that volunteers and
the store pick from. The family keeps hearing from an organisation it has left,
and the Board learns of the departure late, if at all.

## Objective

A household lead can tell the Board, from the household page, that the family is
leaving. From that moment the family gets no renewal email and appears on no
member list. The Board sees the request, settles anything the family still holds,
and ends the membership with the revoke it already uses. Nothing is deleted, and
the family can come back through the normal application.

## Executive summary

| | |
|---|---|
| **The family** | A household lead presses "We're leaving" on the household page and confirms. Either lead may withdraw the request until the Board acts. |
| **At once** | No renewal opens for the household and no renewal email goes to it. It drops off the store's member list and people search's member filter. |
| **Unchanged until the Board acts** | Membership status, member pricing, facility access, program places, roles, trusted adults and background-check records. The family is still a member. |
| **The Board** | Sees a "Leaving" pill on the household and a red count in its nav, and gets one email. It confirms by revoking, the same action as today, after settling program places and roles by hand. |
| **Coming back** | A revoked household starts a joining application like any other, or continues a renewal it still has open. |
| **Kept** | The account and its sign-in, every record and the audit trail. Deleting personal data stays a separate request under the Records Policy. |
| **Cost** | One nullable column, two registered routes, four existing queries narrowed, one board count, two screens. No contract migration. |

The Board's answer, "add this", does not say which of B28's options it adopted.
This design builds option 2 (the family asks, the Board confirms) because it
changes no existing rule about who ends a membership. Option 3 (leaving ends the
membership at once) is a small delta, described under
[If the Board meant option 3](#if-the-board-meant-option-3). Which one applies is
open question L1.

## Rules this relies on

From `docs/rules/membership.md`, `people-households.md`, `programs.md`,
`revenue.md` and `principles.md`:

- Membership belongs to a family, and the fee is per family per membership year.
  (*Membership Policy, Art. III §III.1*)
- No refund once membership is approved, absent an extreme circumstance the
  board approves. (*Membership Policy, Art. XII*) Refunds happen outside the app.
- Being removed from a volunteer role is not dismissal from membership.
  (*Volunteer Policy, Art. V*) Leaving is not dismissal either: dismissal is the
  Board's act against a member, leaving is the member's own choice.
- A member may ask for personal information to be deleted, except where it is
  legally required, needed for member safety, or a condition of something they
  keep. Records no longer needed for operations or required by law should not be
  kept. (*Records Policy, Art. V §V.4; Art. VI §VI.2*)
- An active household stops being one only by revocation or denial. Lapsing
  changes nothing; only a person revokes.
- Deny, restore, grant and revoke are refused for the acting person's own
  household.
- Revoking leaves trusted adults, their authorisations and program ties as they
  are, and sends nothing to the board. Revocation keeps sign-in; a former member
  keeps app access and loses facility privileges.
- A revoked household continues a renewal it already has open, or else starts a
  new joining application.
- Renewal outreach goes only to leads of active households. Renewals start only
  from the Board's own actions.
- A paid program place is removed only by the Board, with a written reason. A
  lead may withdraw a youth's unpaid place. Leaving a program is recorded, not
  erased.
- The background-check obligation follows an active membership; a revoked
  household's leads owe nothing.
- A household has at most two leads; a youth is never a lead.
- Only the Board archives a household, and never one with an ACTIVE membership.
- Automation classifies, warns and escalates; it does not act on a person.
  (*Principle: people decide about people*)

The register is silent on a family resigning. No rule changes under option 2;
the new rules it adds are listed under [Register candidates](#register-candidates).

## Decisions

### 1. Who may leave

- **Any household lead, alone.** A household has at most two leads, and the app
  takes both signing adults to be leads. Asking both to act would strand a family
  whose second lead never signs in, and the Board's confirmation is the check
  against one lead acting against the other's wishes. The request names who made
  it, in the audit row, and the Board sees that name.
- **A non-lead and a youth cannot.** Membership decisions in a household are the
  leads', as signing the agreement is.
- **The whole household only.** Membership belongs to the family
  (*Membership Policy, Art. III §III.1*), so one member cannot leave it and stay
  in the household. A person who leaves the family, such as an adult child moving
  out, is moved to a household of their own by the Board or a sysadmin, as today.
  Letting a lead remove a member themselves is out of scope (L9).
- **Only an ACTIVE household, not archived.** A household with no membership, a
  revoked one and a denied one have nothing to leave. An archived one refuses
  every change already.
- **A Board member's household may ask.** The Board member's own role is not
  removed by the request. Confirming is a revoke, so the existing own-household
  bar means another Board member confirms it.

### 2. What leaving does

The request is recorded the moment the lead confirms it. The household stays
ACTIVE until the Board revokes; the table says what changes at each step.

| Thing | At the request | At the Board's confirmation (revoke) |
|---|---|---|
| Renewal emails | Stop: the outreach audience skips the household. | Stay stopped: outreach goes only to ACTIVE households. |
| Renewal opening | The Board's renewal run skips the household. | Skipped, as for any revoked household. |
| An open renewal application | Left open. The Board sees it on the household and may close it, or record a refund for a paid one, with the tools it has. | Left as it is; a revoked household may still continue it, which is one way back. |
| Store member list, people search member filter | The household drops off both. | Off, as for any revoked household. |
| Member pricing, payment-plan eligibility, members-only programs, facility access | Unchanged: the family is still a member. | Ended, as by any revoke. |
| Program places | Unchanged. The lead can already withdraw a youth's unpaid place. | Unchanged by the revoke. The Board's leave item lists every place and role in a program not yet finished; the Board removes paid places by hand, with a reason, after speaking to the program's leaders. No refund absent an extreme circumstance (*Membership Policy, Art. XII*). |
| Roles (volunteer, program lead, keyholder, Board, reviewer, finance) | Unchanged. | Unchanged by the revoke; listed on the Board's item for removal by hand. |
| Trusted adults | Unchanged. The family can already withdraw any trusted adult. | Unchanged, as the revoke rule says. Each approval runs to its own end date. |
| Background checks | Unchanged. | Unchanged. The clearance and its review stay on record; the per-person obligation ends because it follows an active membership. An open check review stays in the reviewers' queue (L4). |
| The account | Kept. | Kept: sign-in works, as for any revoked household. Not archived and not deleted. The Board may archive later through its existing path once the household meets the preconditions. |
| Audit and history | One audit row for the request, one for a withdrawal. | The revoke's own audit row. Nothing is deleted. |

Two choices in the table deserve their reasons.

**Only emails and lists change at once.** B28 option 2 says the family "is taken
off renewal emails and member lists straight away". Pricing, access and program
eligibility all ask whether the membership is ACTIVE, and they stay with that
question: ending them is ending the membership, which is the Board's act under
option 2. Narrowing four queries is the whole of the at-once effect.

**Program places and roles are listed, not removed.** The denial path is the
model: it sends program ties to the Board for removal by hand, so the Board can
speak to the program's leaders first. Leaving is gentler than a denial, so this
design lists the ties on the Board's leave item rather than opening rows in the
payment-problems queue. L2 asks whether the Board wants the queue rows instead.

### 3. How it is undone

- **Before the Board acts:** either lead withdraws the request on the household
  page. The household is back on emails and lists at once, and the Board's count
  drops.
- **The Board declines:** a Board member may clear the request, with a reason,
  for example when the family asked by mistake. The household stays ACTIVE.
- **After the revoke:** the family comes back as any revoked household does: it
  continues a renewal it still has open, or starts a fresh joining application.
  That application needs a signed agreement for the year, payment, and a lead's
  valid clearance, or a new check if the lead's has expired. There is no shorter
  path: the agreement is signed per year anyway, and a lead's still-valid
  clearance already spares a returning family a new check.
- **A status change clears the request.** The request means something only while
  the household is ACTIVE, so it is cleared when the household leaves ACTIVE
  (revoke or denial). A family that rejoins starts with no stale request. The
  audit row keeps the history.

### 4. Where the Board sees it

- A **"Leaving" pill** on the household in the Board's households list, with the
  date and the lead who asked, beside the revoke control.
- A **red count** in the Board's nav for households asking to leave, in the same
  family as the count for applications missing a signature or check.
- **One email** to the Board when a request is made, naming the household and the
  lead. No email when it is withdrawn.
- The **leave item** on the household lists what the Board has to settle: an open
  application and whether it holds a payment, program places and roles in
  programs not yet finished, and live trusted-adult approvals.

The family gets no email. The on-screen confirmation is an acknowledgement, not a
decision; the Board's revoke is the decision, and the Board tells the family, as
it does for every other membership decision.

### 5. Legal and records

The register covers:

- **Refunds:** none once membership is approved, absent an extreme circumstance
  the board approves (*Membership Policy, Art. XII*). A family leaving mid-year
  gets no automatic refund; the Board may approve one, issued outside the app.
- **Deleting personal data:** a separate request under *Records Policy,
  Art. V §V.4*, not part of leaving. Leaving deletes nothing.
- **Leaving is not dismissal:** dismissal is "without refund" and bars the
  person from membership (*Definitions Policy*, "Dismiss from Membership";
  *Membership Policy, Art. IX*). A family that left may apply again.

The register is silent on:

- **Resignation itself.** The Membership Policy has no resignation line. Under
  option 2 the Board's revoke ends the membership, so no rule needs one; under
  option 3 the family ends it. L6.
- **How long a departed family's records are kept.** *Records Policy,
  Art. VI §VI.2* says records no longer needed should not be kept, and names no
  period. This design keeps everything, as revoke does today. L5.

### Register candidates

For `docs/rules/membership.md`, Procedure, if the design is agreed:

- A household lead may ask for the household's membership to end. The request
  stops renewal outreach and the renewal run for the household, and takes it off
  the store's member list and people search's member filter, at once. It changes
  nothing else; the Board ends the membership by revoking it.  [Decision]
- Either lead may withdraw the request, and a Board member may clear it with a
  reason, until the Board revokes. A status change away from ACTIVE clears it.  [Decision — *Principle: decisions are reversible*]
- A leave request is the family's own request, not a decision, so it carries no
  own-household bar. The Board's revoke that follows it keeps the bar.  [Decision — *Policy: Ethics Policy, Art. III §III.5*]

## Mechanism

### Data

One nullable column on the household's membership: `OrgMembership.leaveRequestedAt`
(`DateTime?`, `@sensitivity:internal`). Null means no request. Who asked, who
withdrew and who cleared live in the audit rows; no person foreign key, so the
person-merge drift guard is not touched.

`setHouseholdStatus`, the one writer of the status, sets the column to null in the
same update whenever it moves the row out of ACTIVE.

### Service

`lib/membership/leave.ts`, three functions, each a compare-and-set with its audit
row in one transaction:

- `requestLeave(personId)`: the caller is a lead of an ACTIVE, live household with
  no request; sets the column. Sends the Board email after commit.
- `withdrawLeave(personId)`: the caller is a lead of that household and a request
  is open; clears it.
- `clearLeave(householdId, actor, reason)`: Board only, outside its own
  household; clears it with a reason.

A repeated request or withdrawal is a no-op success (*Principle: apply once*).

### Queries narrowed

One shared clause, `{ orgMembership: { leaveRequestedAt: null } }`, added to:

- the outreach audience (`lib/outreach/recipients.ts`);
- the renewal run (`runRenewalSweep` in `lib/membership/renewal.ts`);
- the store's member list (`GET /api/shop/org-members`);
- people search's member filter and roster (`GET /api/people/search`).

`ACTIVE_ORG_MEMBER_PERSON_WHERE` itself is not changed: it is the shared "is a
member" question, and widening the leave into it would end pricing and access
too, which is the revoke's job.

### Routes

- `POST /api/household/leave` and `DELETE /api/household/leave`: authenticated;
  the service checks the lead. Each returns the household's `OrgMembership`,
  under the same view as `GET /api/household`.
- The Board's clear: a `clearLeave` branch on `POST /api/membership-ops/households`,
  which already carries the own-household bar and the Board and sysadmin gate.
  It is a `withAuth` route, not a registered one, so it needs no registry entry.
  Whether a sysadmin may clear is the same unsettled superuser question as the
  rest of that route (#1551).
- The Board's confirmation is the existing revoke on the same route, unchanged.

### UI

- Household page, leads only: a "We're leaving" control under the membership
  status, a confirmation that says what changes now and what waits for the
  Board, and "Withdraw" while the request is open.
- Board households list: the "Leaving" pill and the leave item.
- Board nav: the red count, through `lib/nav/todoCounts.ts`.

### Tests

- Unit: the service's three functions (lead, non-lead, youth, non-ACTIVE,
  archived, repeat); the four narrowed queries; `setHouseholdStatus` clearing the
  column on revoke and deny.
- Integration: request, withdraw, Board clear and revoke against a real database,
  including a race between a withdrawal and a revoke.
- Flow: `flow-tests/leave-membership.flow.test.ts`: a seeded lead asks to leave,
  the Board sees the count, revokes, and the lead's household reads as revoked
  with sign-in still working.

## If the Board meant option 3

Option 3 ends the membership at the lead's press, with no Board step. The delta:

- The lead's `POST /api/household/leave` calls `setHouseholdStatus` ACTIVE to
  REVOKED with the lead as actor. A new transition row (actor "household lead")
  is added to the status table.
- No column, no withdraw, no Board clear, no narrowed queries: REVOKED already
  takes the household off everything that asks whether it is ACTIVE.
- The Board's view becomes a notice of what happened: the email and an entry in
  the households list, plus the leave item listing places and roles to settle.
- Undo is rejoining only.
- Two rules change, and the owner must agree them: "only a person revokes"
  gains "or the family itself", and "deny, restore, grant and revoke are refused
  for the acting person's own household" gains an exception for a lead revoking
  their own. The Membership Policy may need a resignation line (L6).

The PR plan below loses PR 2 and most of PR 3.

## Open questions for the owner

| ID | Question | Default in this design |
|---|---|---|
| L1 | Did the Board's "add this" adopt option 2 (the family asks, the Board confirms) or option 3 (leaving ends it at once)? | Option 2. |
| L2 | Program places and roles at confirmation: listed on the Board's leave item, or opened as rows in the payment-problems queue as a denial does? | Listed on the leave item. |
| L3 | Trusted-adult approvals: kept to their own end date, as a revoke leaves them, or ended when the Board confirms? | Kept. |
| L4 | An open background-check review for a member of the leaving household: left in the reviewers' queue, or closed at confirmation? | Left; reviewers or the Board dismiss it by hand. |
| L5 | How long are a departed family's records kept? The Records Policy says records no longer needed should not be kept, and gives no period. | Kept indefinitely, as for any revoked household today. |
| L6 | Does the Membership Policy need a resignation line? Needed if L1 is option 3; optional under option 2. | No policy change under option 2. |
| L7 | Should the Board's confirmation also close the household's open unpaid renewal application, as archiving and restore close applications? | No; the Board closes it with the existing tool if it wants. |
| L8 | Which lists drop the household at once: outreach, the renewal run, the store's member list and people search's member filter? Anything else, or less? | Those four. |
| L9 | Should a lead be able to remove a member from the household themselves (one person leaving), or does that stay a Board and sysadmin move? | Stays a Board and sysadmin move; out of scope. |
| L10 | Board notice: one email plus the nav count, or the nav count alone? | Email plus count. |

## PR plan

Each PR is based on `main`; none stacks on another.

1. **Registry entries (boundary, alone).** `POST /api/household/leave` and
   `DELETE /api/household/leave` in `src/security/registry.ts`, with their
   tests. An unused `defineRoute` is inert, so this ships first.
2. **Migration (expand only).** Add `OrgMembership.leaveRequestedAt`, nullable,
   with its `@sensitivity` annotation. Old code ignores the column, so it is safe
   against the old code still serving traffic. There is no contract step: the
   column stays.
3. **Service and routes.** `lib/membership/leave.ts`, the two route handlers,
   the Board's clear branch, `setHouseholdStatus` clearing the column, the four
   narrowed queries, the Board email, the nav count, unit and integration tests,
   the flow test, and the register lines above. Closes #3446 only if PR 4 has
   merged; otherwise PR 4 closes it.
4. **UI.** The household page control and confirmation, the Board's pill, leave
   item and count.

## Appendix: provenance

- Issue #3446, "Self-service: a family can leave the membership".
- Board question B28 in the Board questions doc, raised 2026-11-15, answered
  "add this" on 2026-11-17. Its options: 1 keep as today; 2 a "We're leaving"
  button with the Board confirming; 3 a "Leave membership" button that ends it at
  once. Its sub-questions (program places and roles, trusted adults, the account,
  who may do it, coming back) map to sections 1 to 3 above.
- Related: B26, families that do not renew. A household that simply stops
  paying lapses and is revoked by the Board; this design does not change that.
