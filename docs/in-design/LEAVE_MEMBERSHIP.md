# A family tells the Board it won't renew

Design for issue #3446, applying Board question B28 ("A family that wants to
leave the membership"), which the Board answered "add this" on 2026-11-17, and
the owner's direction of the same day: a family that has paid for a year keeps
that year, the Board is told, and nothing is revoked.

## Problem

A family that has decided not to continue has no way to say so in the app. It
keeps getting renewal emails, and the Board learns the family has gone only if
someone mentions it. The only tool the Board has is revoking the membership,
and revoking at the family's word would take away a year the family has already
paid for and invite the question of a refund, which policy does not give.

## Objective

A household lead can tell the Board, from the household page, that the family
won't be renewing. The family keeps everything its paid year gives it until that
year ends. It gets no more renewal emails, and the Board is told. The family can
change its mind at any time, with no penalty, by renewing as any member does.

## Executive summary

| | |
|---|---|
| **The family** | A household lead chooses "We won't be renewing" on the household page. The page says the membership continues to the end of the paid year and that the family can renew at any time. Either lead can undo it. |
| **What changes** | Renewal emails stop for the coming year. That is all. |
| **What does not change** | Membership status, member pricing, the store's member list, people search, facility access, program places, roles, trusted adults and background-check records. The family paid for the year and keeps it. |
| **The Board** | Gets one email, sees a "Not renewing" label on the household, and sees the same tag on the family's renewal in the Applications tab, so a "no" is distinct from "not yet". It has nothing to approve. |
| **Changing their mind** | The family renews the normal way: the renewal the Board opens each year is still opened for them, and confirming it clears the note. No new application, no penalty. |
| **At the end of the year** | The membership lapses, as for any family that does not renew. What happens after that is B26's question, not this design's. |
| **Cost** | One nullable column, two registered routes, one narrowed query, one email, two small screens. |

This is neither of B28's options 2 and 3 as written. Both ended the membership
early, by the Board's revoke or by the family's own press, and ending it early
sets up a refund expectation that *Membership Policy, Art. XII* does not meet.
The owner's direction keeps the paid year whole instead.

## Rules this relies on

From `docs/rules/membership.md`, `programs.md`, `revenue.md` and `principles.md`:

- The fee is per family per membership year, and a payment buys one membership
  year. (*Membership Policy, Art. III §III.1; Art. XI*)
- No refund once membership is approved, absent an extreme circumstance the
  board approves. (*Membership Policy, Art. XII*) Refunds happen outside the app.
- Coverage is what was bought: a household settled for the year in effect is
  covered to the boundary that closes it. Lapsing changes what the membership
  covers and nothing else; only a person revokes.
- Renewal outreach goes only to household leads of active households; the
  opening message to every lead, the reminder to those not yet renewed.
- Renewals start only from the Board's own actions; the family confirms the
  renewal the Board opened.
- A paid program place is removed only by the Board, with a written reason.
- Automation classifies, warns and escalates; it does not act on a person.
  (*Principle: people decide about people*)

No existing rule changes. The new rules are listed under
[Register candidates](#register-candidates).

## Decisions

### 1. Who may say it

- **Any household lead, alone.** Renewing is a lead's act, so declining to renew
  is too. Requiring both leads would strand a family whose second lead never
  signs in. The audit row names who said it, and the Board's email names them.
- **Not a non-lead or a youth,** for the same reason they cannot confirm a
  renewal.
- **The whole household.** Membership belongs to the family
  (*Membership Policy, Art. III §III.1*). One person leaving the family, such as
  an adult child moving out, is the Board's or a sysadmin's move to a household of
  their own, as today (L9).
- **Only an ACTIVE household, not archived,** and only while the family has not
  already paid for the coming year. A family that has renewed has nothing left to
  decline; talking to the Board is the way out of a renewal already paid.

### 2. What it does

The note is recorded against the coming membership year: the year after the one
now in effect. It means "we won't be renewing into that year".

| Thing | Effect |
|---|---|
| Renewal emails for that year | Not sent: the opening message and the reminders skip the household. |
| The renewal itself | Still opened by the Board's renewal run, so the family can confirm it if it changes its mind. Nothing is sent about it. |
| Membership status | Unchanged. The family stays ACTIVE. |
| Member pricing, payment-plan eligibility, members-only programs, facility access | Unchanged to the end of the paid year. |
| Store's member list, people search | Unchanged. The family is a member and is listed as one. |
| Program places and roles | Unchanged. Places paid for stay; roles stay until whoever grants them removes them. The Board's email lets it plan. |
| Trusted adults | Unchanged; each approval runs to its own end date, and the family can withdraw one as it always could. |
| Background checks | Unchanged. |
| The account | Kept, with sign-in. Deleting personal data is a separate request under *Records Policy, Art. V §V.4*. |
| Audit | One row when the note is made, one when it is undone or cleared. Nothing is deleted. |

**Why only the emails.** Everything else the family has, it bought with the
year's fee. Taking any of it away early is ending the membership early, which is
what the owner ruled out. The emails are the one thing the family is asking to
stop, and stopping them takes nothing from anyone.

**Why the renewal is still opened.** An open, unconfirmed renewal costs the
family nothing and is the door back: confirming it is how any member renews.
Skipping it would make changing one's mind a request to the Board, which is a
penalty of a kind.

### 3. Changing their mind

- **Undo:** either lead removes the note on the household page. The emails
  resume with the next send.
- **Renewing undoes it too:** confirming the renewal clears the note in the same
  step, so a family that renews is never labelled "Not renewing".
- **After the year ends:** the household lapses like any family that did not
  renew. Whatever B26 decides for those families applies here unchanged; this
  design adds nothing to it. A note for a year that has passed means nothing and
  is ignored, so no clean-up job is needed.

### 4. Where the Board sees it

- **One email** to the Board when a lead makes the note, naming the household,
  the lead and the year. No email on undo.
- **A "Not renewing" label** on the household in the Board's households list,
  with the year and the date it was said.
- **A "Not renewing" tag on the renewal** in the Board's Applications tab. That
  tab lists every open application with its state as a coloured badge, and a
  renewal still waiting for the family to confirm it reads "Pending renewal".
  Without a tag the Board cannot tell a family that hasn't got round to it from
  one that has said no, so the not-renewing ones carry the tag beside their
  state, and the tag is a filter like the state badges, with its own count. The
  tag shows only while the renewal is unconfirmed; confirming clears the note
  and so the tag.
- No count in the Board's menu: there is nothing for the Board to do. L10 asks
  whether the owner wants one anyway.

The family gets no email. The household page shows what it has said and how to
undo it, and the renewal banner that reminds a lead to renew changes, for that
year, to say the family has said it won't renew and can still renew from here.

### 5. Legal and records

The register covers:

- **Refunds:** none once membership is approved, absent an extreme circumstance
  the board approves (*Membership Policy, Art. XII*). This design ends nothing
  early, so it raises no refund question. A family that asks for one is a
  conversation with the Board, as today.
- **Deleting personal data:** a separate request under *Records Policy,
  Art. V §V.4*. Not renewing deletes nothing.
- **Not renewing is not dismissal** (*Definitions Policy*, "Dismiss from
  Membership"; *Membership Policy, Art. IX*): the family may renew or apply again
  at any time.

The register is silent on:

- **How long a departed family's records are kept.** *Records Policy,
  Art. VI §VI.2* says records no longer needed should not be kept and names no
  period. This design keeps everything, as for any lapsed family today. L5.
- **Resignation.** The Membership Policy has no resignation line. This design
  needs none, because nothing ends before the paid year does. L6 asks the owner
  to confirm.

### Register candidates

For `docs/rules/membership.md`, Procedure > Renewal, if the design is agreed:

- A household lead may say the household won't renew into the coming membership
  year. It stops that year's renewal outreach to the household and changes
  nothing else: the year already paid for runs to its end, and the renewal is
  still opened.  [Decision — *Policy: Membership Policy, Art. XI; Art. XII*]
- Either lead may undo it, and confirming the renewal undoes it.  [Decision — *Principle: decisions are reversible*]
- The Board is told and has nothing to approve; the family's choice is not a
  decision about anyone.  [Decision]

## Mechanism

### Data

One nullable column on the household's membership:
`OrgMembership.notRenewingYear` (`Int?`, `@sensitivity:internal`), the
membership year the family won't renew into. Null means no note. A value for a
year that is no longer the coming year is ignored, so nothing has to clear it at
the boundary. Who said it lives in the audit row; no person foreign key, so the
person-merge drift guard is not touched.

### Service

`lib/membership/notRenewing.ts`, each function a compare-and-set with its audit
row in one transaction:

- `markNotRenewing(personId)`: the caller is a lead of an ACTIVE, live household
  that has not settled the coming year; sets the column to the coming year.
  Sends the Board email after commit.
- `clearNotRenewing(personId)`: the caller is a lead of that household; sets it
  to null.

`beginRenewal` sets the column to null in the same transaction that moves the
renewal forward. A repeat of either call is a no-op success
(*Principle: apply once*).

### Query narrowed

The outreach audience (`lib/outreach/recipients.ts`) skips a household whose
`notRenewingYear` is the coming year, for both the opening message and the
reminder. Nothing else reads the column apart from the household page and the
Board's households list.

### Routes

- `POST /api/membership/not-renewing` and `DELETE /api/membership/not-renewing`:
  authenticated; the service checks the lead. Each returns the household's
  `OrgMembership`, under the same view as `GET /api/household`.
- The Board's households list (`GET /api/membership-ops/households`) adds the
  column to what it reads. It is a `withAuth` route, so no registry change.
- The Applications tab's list (`GET /api/membership-ops/applications`) adds a
  `notRenewing` flag to each renewal row: true when the row is a renewal for the
  household's noted year. That route is registered, so whatever the flag's
  type needs in the registry ships in PR 1 with the new routes.
- The renewal-status read behind the lead's renewal banner
  (`GET /api/membership/renewal-status`) adds the same flag, so the banner can
  change its wording.

### UI

- Household page, leads only, under the membership status: "We won't be
  renewing". The confirmation says, with the real date, that the membership
  continues to the end of the paid year, that renewal emails stop, and that the
  family can renew at any time from this page. While the note stands the page
  shows it with an undo, and the renew control stays where it is.
- Board households list: the "Not renewing" label with the year and date.
- Board Applications tab: the "Not renewing" tag beside a renewal's state, and a
  filter badge with its count. Another session is adding renewal status badges to
  this tab; whichever lands second builds on the other.
- The lead's renewal banner: for the noted year it reads "You've told the Board
  you won't be renewing" with the renew control, instead of the reminder.

### Tests

- Unit: mark and clear (lead, non-lead, youth, non-ACTIVE, archived, coming year
  already paid, repeat); the outreach audience skipping only the noted year;
  `beginRenewal` clearing the note.
- Integration: mark, then confirm the renewal, against a real database.
- Flow: `flow-tests/not-renewing.flow.test.ts`: a seeded lead marks the
  household, the outreach audience no longer contains it, the lead undoes it and
  it returns.

## Open questions for the owner

IDs are stable; the first version of this design asked L1 to L10, and the
owner's direction of 2026-11-17 answered several.

| ID | Question | Status or default |
|---|---|---|
| L1 | Option 2 or option 3? | Answered: neither. The family keeps its paid year; the Board is notified; nothing is revoked. |
| L2 | Program places and roles at leaving? | Answered: unchanged; the family paid for the year. |
| L3 | Trusted-adult approvals? | Answered: unchanged. |
| L4 | Open background-check reviews? | Answered: unchanged. |
| L5 | How long are a departed family's records kept? The Records Policy names no period. | Open. Default: kept, as for any lapsed family. |
| L6 | Does the Membership Policy need a resignation line? | Open. Default: no, because nothing ends early. |
| L7 | Close the household's open renewal? | Answered: no; it stays open as the way back. |
| L8 | Which lists drop the household? | Answered: none. Only renewal emails stop. |
| L9 | Can a lead remove one member from the household themselves? | Open. Default: no; stays a Board and sysadmin move, out of scope. |
| L10 | Board notice: email and label only, or a count in the Board's menu too? | Open. Default: email and label; no count, since there is nothing to do. |
| L11 | The control's wording: "We won't be renewing", or other words? | Open. Default: "We won't be renewing", with the label "Not renewing" for the Board. |
| L12 | Should the family be able to say it outside the renewal window, for example in March? | Open. Default: yes, at any time; it applies to the coming year. |

## PR plan

Each PR is based on `main`; none stacks on another.

1. **Registry entries (boundary, alone).** `POST` and
   `DELETE /api/membership/not-renewing` in `src/security/registry.ts`, and
   whatever the `notRenewing` flag on `GET /api/membership-ops/applications`
   rows needs there, with their tests. An unused `defineRoute` is inert, so this
   ships first.
2. **Migration (expand only).** Add `OrgMembership.notRenewingYear`, nullable,
   with its `@sensitivity` annotation. Old code ignores it, so it is safe against
   the old code still serving traffic. No contract step.
3. **Service, routes and outreach.** `lib/membership/notRenewing.ts`, the two
   route handlers, the outreach audience, `beginRenewal` clearing the note, the
   Board email, the households list field, tests, and the register lines above.
4. **UI.** The household page control, the lead's renewal banner, the Board's
   households label and the Applications tab tag and filter. Closes #3446.

## Appendix: provenance

- Issue #3446, "Self-service: a family can leave the membership".
- Board question B28 in the Board questions doc, raised 2026-11-15, answered
  "add this" on 2026-11-17. Its options were 1 keep as today; 2 a button with the
  Board confirming by revoke; 3 a button that ends the membership at once.
- Owner review of the first draft, 2026-11-17: the paid year is the family's to
  keep; revoking at the family's word is wrong because it sets up refund
  expectations; the family can come back without penalty; the Board is notified.
  The first draft (option 2, with the household dropping off member lists at
  once) is replaced by this one.
- Related: B26, families that do not renew. This design ends where B26 begins.
