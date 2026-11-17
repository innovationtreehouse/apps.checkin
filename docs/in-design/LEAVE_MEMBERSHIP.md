# A family tells the Board it won't renew

Design for issue #3446 (Board question B28).

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
  (*Membership Policy, Art. III §III.1*), so the note covers the household.
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
- No count in the Board's menu: there is nothing for the Board to do.

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
- **No resignation line in policy:** none is needed, because nothing ends before
  the paid year does.

How long a departed family's records are kept (*Records Policy,
Art. VI §VI.2*) is out of scope: no record is yet old enough for that policy to
apply.

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

Everything in this section is proposed. None of it exists in the code yet: no
column, no service, no routes, and no change to any existing writer.

### Data

One nullable column on the household's membership:
`OrgMembership.notRenewingYear` (`Int?`, `@sensitivity:internal`), the
membership year the family won't renew into. Null means no note. A value for a
year that is no longer the coming year is ignored, so nothing has to clear it at
the boundary. Who said it lives in the audit row; no person foreign key, so the
person-merge drift guard is not touched.

### Service

`checkin-app/src/lib/membership/notRenewing.ts`, each function a compare-and-set with its audit
row in one transaction:

- `markNotRenewing(personId)`: the caller is a lead of an ACTIVE, live household
  that has not settled the coming year; sets the column to the coming year.
  Sends the Board email after commit.
- `clearNotRenewing(personId)`: the caller is a lead of that household; sets it
  to null.

PR 3 changes `beginRenewal`, which today writes only the renewal, so that it
also sets the column to null in the same transaction that moves the renewal
forward. A repeat of either call is a no-op success
(*Principle: apply once*).

### Query narrowed

The outreach audience (`checkin-app/src/lib/outreach/recipients.ts`) skips a household whose
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
- Flow: `checkin-app/flow-tests/not-renewing.flow.test.ts`: a seeded lead marks the
  household, the outreach audience no longer contains it, the lead undoes it and
  it returns.

## Open questions for the owner

| ID | Question | Default |
|---|---|---|
| L11 | The control's wording: "We won't be renewing", or other words? | "We won't be renewing", with the label "Not renewing" for the Board. |
| L12 | Should the family be able to say it outside the renewal window, for example in March? | Yes, at any time; it applies to the coming year. |

## PR plan

Each PR is based on `main`; none stacks on another.

1. **Registry entries (boundary, alone).** `POST` and
   `DELETE /api/membership/not-renewing` in `checkin-app/src/security/registry.ts`, and
   whatever the `notRenewing` flag on `GET /api/membership-ops/applications`
   rows needs there, with their tests. An unused `defineRoute` is inert, so this
   ships first.
2. **Migration (expand only).** Add `OrgMembership.notRenewingYear`, nullable,
   with its `@sensitivity` annotation. Old code ignores it, so it is safe against
   the old code still serving traffic. No contract step.
3. **Service, routes and outreach.** `checkin-app/src/lib/membership/notRenewing.ts`, the two
   route handlers, the outreach audience, `beginRenewal` clearing the note, the
   Board email, the households list field, tests, and the register lines above.
4. **UI.** The household page control, the lead's renewal banner, the Board's
   households label and the Applications tab tag and filter. This PR closes
   #3446.

## Appendix: provenance

- Issue #3446, "Self-service: a family can leave the membership".
- Board question B28 in the Board questions doc.
- Related: B26, families that do not renew. This design ends where B26 begins.
