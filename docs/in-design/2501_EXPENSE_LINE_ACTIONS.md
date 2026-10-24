# One action per person per expense line

## Problem

Every line of an expense waits on several people. The owner or a treasurer of
the line's budget bucket approves it. Then three people sign it: the person who
submitted the receipt, a program approver, and the Treasurer. Some lines need a
Board member as well. Finance can approve in place of the bucket's approvers,
and it settles the exceptions they raise.

The expense page shows each viewer every one of those acts, whoever the viewer
is, and leaves the server to refuse the ones they can't take. A bucket owner
looking at one of their lines sees up to six buttons. Two of them, Approve and
Sign as Program approver, record the same judgment twice ("this spending
belongs to my budget"), and the rest are refused when clicked. A Board member
sees Approve on every line, and the server refuses it every time. A finance
holder who also sits on the Board can see six buttons on one line. Four of them
work one at a time, but two are seats and they may fill only one. The submitter, whose signature every line needs, has no
button anywhere, so their expense never reaches the books.

The counts don't match the pages either. The approver's pill counts signatures
waiting on them, while the page it opens lists expenses waiting for approval,
so each line is one decision, counted once and shown twice.

## Objective

Each person sees at most one main action per line. It names the role they act
in, and the server accepts it. Any other act they may take is one click further
away. What waits on someone else shows as plain status. Counts, pages and
buttons come from the same rule the server enforces.

## Executive summary

- **Owner approval and the program-approver seat become one act**
  (recommended, option B below). "Approve as Program approver" records the
  bucket approval and fills the seat together. A Board member standing in for
  the program approver approves the line with the same act. Records and the
  expense state machine stay as they are; one click writes both.
- **The server tells the page what the caller may do** on each line, computed
  by the same function that refuses a click. The page draws only those actions,
  and every other open seat shows as "Awaiting Treasurer" and the like (3.15,
  #2433).
- **Submitters sign at submission** (recommended): an attestation on the receipt
  form, recorded as the submitter seat on every line when the expense is
  created (#2432).
- **Approve All comes back**, as one all-or-nothing request (3.13). Lines waiting
  on the viewer are bold with an arrow (3.14). A required comment is marked, and
  Confirm stays disabled until it's written (3.16). The page returns to the
  approvals list after the viewer's last action (3.12).
- **The approver pill and its page agree**: both count lines with an action for
  the viewer, and the pill opens a "Waiting on you" view (3.25).
- **The FINANCE override gets a rule** (3.17). The proposal keeps it, requires
  the written reason it already needs, and says it settles the approval only,
  never the seat.
- **What doesn't change**: three seats, three people, three households; who sits
  in each seat; the conflict rules; the Board stand-in limits; the Board's
  authorization and the $2,000 hold; finance's exception queue (#2482).
- **Cost**: one boundary PR and six feature PRs. No schema change, unless the
  submitter attestation is stored, which needs one column.

## Rules this relies on or changes

From `docs/rules/expenses.md` on `main`, with each line's tier. Lines #2224
adds are marked as proposed.

| Rule (short form) | Section and tag | Under this design |
| --- | --- | --- |
| Spending sign-off is governed by Financial Policy Arts. IX and XII and Procurement Policy Art. IV | **Policy** | Unchanged. Every line below cites it, so check each change against the policy on Drive |
| A conflicted person may not approve a line, raise an exception, sign any seat, or record Board authorization | Procedure, `[Decision — Policy: Ethics Policy Art. III §III.5]` | Text unchanged. The approve act also takes the seat's own refusals, so it gets stricter (B.1) |
| Each line is signed by the submitter, a program approver and the Treasurer: three people, three households | Procedure, `[Decision — Policy: Financial Policy Art. IX §IX.3]` | Unchanged |
| A bucket's approvers are its owner and treasurers; an org-level bucket has none | Procedure, `[Decision — owner]` | Unchanged. A new line says approval and the seat are one act |
| A conflicted Treasurer does not sign; the conflict includes having approved the line as its program approver | Procedure, `[Decision — Policy: Financial Policy Art. IX §IX.3; Ethics Policy Art. III §III.5]` | Text unchanged. Under B, "approved as program approver" and "signed that seat" are the same act, so the clause and the code mean the same thing. Whether a FINANCE override counts is open question 3 |
| When every bucket approver is conflicted or unavailable, a Board member signs the program-approver seat | Procedure, `[Decision — owner]` | **Changes in effect**: the Board member's act also approves the line. Reworded below |
| Reimbursing a non-member takes a Board member in the program-approver seat | Procedure, `[Decision — Policy: Financial Policy Art. IX §IX.2]` | Unchanged under the recommended B2. **Option B1 would change it; escalate before choosing B1** |
| The submitter's audience may reach a sign-off for the submitter seat, "since that seat is filled from the receipt" | Procedure, `[Decision — owner]` | Affirmed by the recommended S2 and reworded below; S1 rewords it differently |
| Proposed in #2224: finance decides each line's bucket before the program approver signs | Procedure, `[Decision]` | Consistent |
| Proposed in #2224: a line in an org-wide bucket takes a Board member as program approver; at most two Board substitutions on a reimbursement line, one on a card charge | Procedure, `[Decision]` | Consistent |

No Policy-tier line changes. Three Procedure lines that cite a policy are
touched. The Treasurer-conflict line keeps its text. The non-member line changes
only under B1, which is why B1 is flagged. The submitter line depends on how
open question 2 is answered: whether an attestation at submission is a signature
in the sense of Financial Policy Art. IX §IX.3 is for you to check against the
policy itself.

#2483 proposes corrections to the same section: the program approver is "an
owner or treasurer of the line's bucket", and the Board stand-in wording. This
design assumes those corrections and doesn't change them. Its two open questions
(a flag for a Board stand-in in the program-approver seat, and the re-check of
past signers in the stand-in count) stay open here.

## What each role sees and does today

The expense detail page draws its line buttons from two places. In the Approval
column, every viewer sees **Approve** and **Raise exception** on each pending
line while the expense waits for owner approval. FINANCE also sees **Reject
exception** and **Assign bucket** on a line with an exception, **Resolve
bucket** on an unknown one, and **Assign bucket** on an unassigned one. In the
Sign-off column, every viewer sees **Sign as <seat>** for each open seat:
Submitter, Program approver, Treasurer, and Board on lines that take it. These
buttons are disabled only while the reimbursee is unknown, and Sign as Program
approver also while the line has no bucket. A **Record Board authorization**
panel shows to FINANCE and Board while a line waits for it.

Bucket approvers open the page from Programs I Lead › Expense approvals and see
only their own buckets' lines. FINANCE and the Board open it from Expense Ops
and see every line.

| Role | Acts the server accepts on a line | Buttons shown that the server refuses |
| --- | --- | --- |
| **Submitter** with no other role | Sign as Submitter: the route admits them, but no screen calls it (#2432) | None; the page isn't reachable |
| **Submitter** who is also an approver, FINANCE or Board, on their own expense | Sign as Submitter | Approve, Raise exception, every other Sign as: conflicted |
| **Bucket owner or treasurer** | Approve; Raise exception; Sign as Program approver, unless refused below | Sign as Submitter; Sign as Treasurer; Sign as Board. Sign as Program approver too when their household already holds a seat on the expense, when they hold another seat on the line, or when the seat goes to the Board (non-member reimbursee) |
| **Treasurer** (any FINANCE holder) | Sign as Treasurer, unless conflicted: submitter's or reimbursee's household, the bucket owner's household, whoever named the reimbursee, another seat on the line, or a household already seated | Sign as Submitter; Sign as Program approver, unless they also approve that bucket; Sign as Board, unless also Board; Sign as Treasurer in the conflict cases |
| **FINANCE** (overrides and bucket fixes) | Approve on any pending line as an override, with a comment; Raise exception on any pending line; Reject exception, Assign bucket, Resolve bucket; Record Board authorization when not conflicted | Approve with a blank comment: Confirm is enabled and the server answers 400 (3.16) |
| **Board stand-in** (Board, not FINANCE) | Sign as Board on a line that takes the Board seat; Sign as Program approver for an org-level bucket, a non-member reimbursee, or when no approver can sign, within the substitution limit; Sign as Treasurer when no FINANCE holder can; Record Board authorization when no FINANCE holder can | Approve and Raise exception on every line, always. Sign as Submitter. The stand-in seats whenever an eligible signer exists |

Two cases show the problem. A bucket owner whose line has no conflict sees five
buttons, or six on a line that takes the Board seat. They need two of them,
Approve and Sign as Program approver, which record one judgment. A FINANCE
holder on the Board, looking at a pending non-Everyday card charge, sees
Approve, Raise exception and four Sign as buttons. Approve (with a comment),
Raise exception, Sign as Treasurer and Sign as Board are each accepted, but
taking either seat refuses the other, because one person never fills two seats
on a line.

## The central question: one act or two?

Owner approval and the program-approver seat are asked of the same people (the
bucket's owner and treasurers), about the same line, on the same page. They are
different records with different jobs. Owner approval moves the expense through
its states: when every line is approved, the expense goes to capital review or
to the books queue, and an exception goes to finance. The seat holds money back:
a line with an open seat keeps the expense from posting, whatever its state.

### Options

**A. Two acts, each shown only to who can take it.** Keep both records and both
buttons, and fix visibility. This is the smallest change and needs no rule
edit. But the approver still clicks twice per line for one judgment. The pill
has to count both acts, and the two can drift apart: a line approved but not
signed is "done" on the approvals list and still holds the money.

**B. One act, two records (recommended).** "Approve as Program approver" records
the bucket approval and fills the seat in one transaction. Whoever may fill the
seat is the approver, so the approval is refused exactly when the seat would be.
Both records stay, along with the state machine and finance's exception flow on
the approval row (#2482). The approver makes one decision per line.

**C. One act, one record.** Retire the approval row's "approved" status and have
the state machine wait on the seat; exceptions stay on the approval row. Users
see the same thing as under B. It needs a schema change, a state-machine change,
and a migration of approvals in flight, and buys nothing a user would notice.
It can follow B later if the two records become a maintenance problem.

### Why B

B gives the user one act now with no migration, and it keeps every record a
later reader of the audit log expects to find. A gives the user nothing on the
main complaint. C costs more for the same screen.

### What B changes, case by case

**B.1 The approval takes the seat's refusals.** Today an approval is refused
only to the submitter, the reimbursee and their households. Under B it is also
refused when the approver's household already holds a seat on the expense, or
when the approver already holds another seat on the line. That's stricter, and
it fixes a real gap: a bucket treasurer who is also FINANCE can today approve a
line and then sign it as Treasurer.

**B.2 A Board stand-in approves.** When every approver of the bucket is
conflicted or ineligible, a Board member signs the program-approver seat. Today
that line also needs a FINANCE override to leave owner approval, which takes two
people for one decision. Under B the stand-in's one act, "Approve as Board
(program approver)", does both. The Board's stand-in limits are unchanged, and
the act counts as a substitution exactly as the signature does today.

**B.3 Non-member reimbursee.** The seat goes to a Board member, but the bucket
still has approvers. There are two ways to handle it:

- **B1.** The Board member's act approves too, and the bucket's approvers have
  no act on the line. That removes a check the line has today, on a rule that
  cites Financial Policy Art. IX §IX.2, so it needs escalating before anyone
  chooses it.
- **B2 (recommended).** The bucket approver keeps an approval-only act,
  "Approve for <bucket>", and the Board member signs the seat. Two people, each
  with one act, and every check the line has today stays.

**B.4 Org-level bucket.** No change. The approval is pre-approved at intake,
because the bucket has no approvers, and a Board member fills the seat. Their
button reads "Approve as Board (program approver)" so the act reads the same
everywhere.

**B.5 After finance reassigns a line.** When FINANCE settles an exception by
moving the line to another bucket, the approval is closed as finance-assigned
and the moved line's seats are voided. The new bucket's approver then sees the
same "Approve as Program approver". It fills the seat only, because the
approval is already closed. The label is the same, because to the approver it
is the same decision.

**B.6 Timing.** The seat can be signed as soon as the line has a bucket, even
while other lines wait for one. B keeps that. If the approval is still pending,
the act records it in either state, and the existing check when the last bucket
is assigned moves the expense on.

**B.7 The FINANCE override** settles the approval only and never fills the seat.
See §7 of the design.

## Design

### 1. The server says what the caller may do

The sign-off status the page already loads gains, on each line, the acts this
caller may take there:

| Field | Meaning |
| --- | --- |
| `actions[]` | Each act the caller may take now: `approve` (with the seat it fills, or none under B2), `sign` (Treasurer or Board), `raise-exception`, `override`, `reject-exception`, `assign-bucket`, `resolve-bucket` |
| `actions[].primary` | True on at most one act per line |
| `actions[].commentRequired` | The server refuses this act without a comment |
| `awaiting[]` | Open seats and holds the caller can't act on, as plain status: "Awaiting Submitter", "Awaiting Treasurer", "Awaiting a Board stand-in", "Held: no one without a conflict can sign", "Held until finance names the reimbursee", "Held until the Board's approval is recorded" |

The expense gains `mayRecordBoardAuthorization`, from the same check the
recording route runs.

One pure function computes these from the facts the services already read: the
line's sign-off facts, its filled seats, its approval row, the expense state and
the caller's roles. It runs the existing seat refusal for each seat, the
approval's state, status and conflict checks, and the Board-authorization
refusal. The services keep their own refusals and call the same function, so
the page and the server can't disagree. An act the function leaves out is never
drawn, which closes 3.15 and #2433.

A line where the caller has no act shows its status only. Board members stop
seeing Approve. Nobody but the submitter sees a submitter seat, and even they
see it filled (§3).

### 2. Which act is the main one

The main act is the button on the line, named for the role: "Approve as
Program approver", "Approve for Robotics", "Sign as Treasurer", "Sign as Board",
"Approve as Board (program approver)". Other acts go in a "More" menu on the
same line: Raise exception, Override, and any other seat the caller could fill
instead.

When the caller could fill more than one seat on a line (a bucket owner who
holds FINANCE, or a Board member eligible for the Board seat and as a stand-in),
taking one rules out the others, because one person fills one seat per line.
The main act is the seat with the fewest other available signers, ties going
program approver, then Treasurer, then Board. So the button asks the caller for
the seat that is hardest to fill without them.

On a line with an exception raised, FINANCE's main act is Assign bucket, with
Reject exception in More. Those screens belong to #2482; this design only gives
them the same `actions` field.

### 3. The submitter's seat (#2432)

Each line needs the submitter's signature, and the submitter never sees the
expense page. There are two options:

- **S1. A sign step afterwards.** Once the receipt becomes an expense, the
  submitter's receipt page shows "Sign for these purchases", and one button
  signs every line. The submitter has to come back, and until they do the
  expense can't post. The receipt library can't import the expense library, so
  the host composes the step.
- **S2. Submission is the signature (recommended).** The submit form carries an
  attestation the submitter ticks: "I made these purchases for the Treehouse,
  and this receipt is accurate." When the expense is created from the receipt,
  the app records the submitter seat on every line, signed by the submitter, and
  the audit row cites the submission. The submitter acts once, at a moment they
  are already acting. This matches the rule's own words, "that seat is filled
  from the receipt".

Finance's later changes don't void the submitter seat; the seat-voiding already
leaves it alone. A submitter's own correction of tax or date sends the receipt
to finance review. The attestation covers the receipt as submitted, and whether
that is a signature in the sense of Financial Policy Art. IX §IX.3 is for you to
check (open question 2).

A backfilled expense takes no sign-off, so it records no seat. Expenses already
waiting with an empty submitter seat predate any attestation; open question 2
asks how to clear them.

### 4. Approve All (3.13)

When the caller's main act is an approval on two or more lines of the expense,
a button above the table reads "Approve all 4 as Program approver" (or "Approve
all 4 for Robotics" under B2). It sends one request, which checks every line
with the same function under the expense lock and approves all of them or none.
If any line is refused, nothing changes and the error names the line. A partial
batch would leave the approver unsure which lines still wait.

Approve All never includes an override; each override needs its own comment.

### 5. Lines waiting on you (3.14)

A line where the caller has a main act is bold, with an arrow beside its number,
as in the prototype. The heading says how many: "3 of 7 lines wait on you." Line
order stays by line number, which matches the receipt.

### 6. Required comments (3.16)

Wherever `commentRequired` is true, the comment field is marked required and
Confirm stays disabled while it is blank. The server's refusal stays as the
backstop. For approvers and signers that covers Raise exception and Override;
approving and signing take no comment. #2482 §4 sets the same rule for
finance's notes and plans an `overrideRequired` field for it. `commentRequired`
on the override act is that field, so the two designs should use one field
(open question 6).

### 7. The FINANCE override (3.17)

The prototype had an org-manager role that approved without a comment. FINANCE
replaced that role, and now approves outside its own buckets only with a
comment. No rule says so. One fact shapes the proposal: an override moves the
expense out of owner approval, but the program-approver seat still holds the
money. Today, as under B, an override lets capital review and depreciation go
ahead and never posts anything by itself.

**Proposed rule (keep, narrowed):**

> Finance may approve a line in place of its bucket's approvers, with a written
> reason. The override settles the bucket approval only: it never fills the
> program-approver seat, so the line still needs that signature before it
> reaches the books. A finance holder conflicted on the expense may not override.
> `[Decision — owner]`

**Alternative (retire it):** "Only a line's bucket approvers, or a Board member
standing in for them, approve it." Finance would move a stuck line by raising an
exception and reassigning or rejecting it. That's simpler. But it leaves no way
forward when the approvers are eligible and don't act, because the Board stands
in only for approvers who are conflicted or ineligible (open question 5).

I recommend keeping the override with the wording above. Whether the finance
holder who overrides should also be barred from the Treasurer seat on that line
is a new constraint, so it is open question 3 rather than part of the proposal.

### 8. The pill and its page agree (3.25)

The approver pill counts lines where the caller's main act is an approval
(program-approver seat or B2 bucket approval). It uses the same function and the
badge's existing cap of 25 expenses. Because B makes approval and the seat one
act, that one number covers both.

The pill opens Programs I Lead › Expense approvals on a new default view,
"Waiting on you": expenses with at least one such line. Owner approval stays a
view for browsing. The list prefilters in the database as the badge does
(the caller's buckets, seat open, not their own receipt) and then applies the
function, so the list and the pill always agree.

#2492 adds an owner-approval count to the expense queues. Under B that count and
this pill are the same number, and #2492 should take it from the same function.
Treasurer and Board seats aren't on this pill; where FINANCE and the Board find
lines to sign is open question 4.

### 9. Back to the queue (3.12)

#2482 §4 sets the rule for finance: when the page was opened from a queue, and
an action leaves the viewer nothing they can act on, it goes back to that
queue. A partial decision reloads in place. Approvers follow the same rule, and
their queue is the Expense approvals list they came from, already passed to the
page as the back link. "Nothing left" is read from the refreshed `actions`: no
line has a main act for the viewer. Approve All counts as an action. Every
action also fires the event that refreshes the nav counts. Capital review and
depreciation submits are finance's, and #2482 covers them.

### 10. What the new pieces need (3.29)

| New since the prototype | On the line, under this design |
| --- | --- |
| Backfill | No seats and a pre-approved line, so no actions. Status: "Booked before the app; no sign-off" |
| Org-level bucket pre-approval | Pre-approved; a Board member's main act is "Approve as Board (program approver)" (B.4) |
| Sign-off seats | One main act per person, with open seats shown as status (§1, §2) |
| Board seat (non-Everyday card charge without Board authorization) | "Sign as Board" for an eligible Board member; status for everyone else |
| Board approval hold ($2,000) | Status "Held until the Board's approval is recorded"; the act is the Record Board authorization panel, shown only when `mayRecordBoardAuthorization` is true (#2482 handles the Board's queue for it) |
| Conflict refusals | Computed into `actions`, so a conflicted act is never drawn |
| Board stand-in limits | Computed the same way. A line past the limit shows "Held: no one without a conflict can sign" |

## Proposed rule text

To land in `docs/rules/expenses.md`, Spending sign-off, if you accept B2 and S2:

- A bucket approver approves a line by signing its program-approver seat; one
  act records both. Whoever may not sign that seat may not approve the line.
  `[Decision — owner]`
- When every owner and treasurer of a line's bucket is conflicted or
  unavailable, a Board member without a conflict signs the program-approver
  seat, and that signature approves the line. *(rewords the existing line;
  same tag)*
- Reimbursing a non-member takes a Board member in the program-approver seat.
  The bucket's approvers still approve the line, by an approval that fills no
  seat. *(adds the second sentence to the existing line; same tag)*
- The submitter signs the submitter seat by attesting the receipt when they
  submit it; the seat is recorded on every line when the expense is created.
  *(replaces "since that seat is filled from the receipt" in the audience line;
  same tag)*
- The override rule in §7.

## Routes and the security registry

| Item | Change |
| --- | --- |
| `GET /api/expense/expenses/[id]/signoffs` | Gains `actions` and `awaiting` per line and `mayRecordBoardAuthorization`. These describe the caller only, so they name no one else |
| `POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/approve` | Under B, fills the seat in the same transaction; admits a Board stand-in |
| `POST /api/expense/expenses/[id]/approve-lines` | New, for Approve All; `expense-approver`, with the library checking each line |
| `GET /api/expense/queue`, `GET /api/expense/expenses` | Accept the `awaiting_me` view; no new route |
| Receipt submit | Under S2, carries the attestation; the receipt-to-expense contract gains it, alongside the review outcome theme 2 adds |

The new fields on `ExpenseLineSignoffStatus` change a synthetic
classification, and the new route needs a registry entry. Both ship in one
boundary-only PR on `main` before any feature PR, under the boundary isolation
rule. #2482's registry PR A adds `overrideRequired` to the approvals response.
Agree with that work whether one boundary PR carries both or `actions` replaces
`overrideRequired`, so the registry doesn't gain two fields for one fact.

## Rollout

Each PR is based on `main`, not stacked.

1. **Registry PR** (boundary only): the new fields and the `approve-lines`
   entry. Coordinate with #2482's registry PR A.
2. **Line actions PR** (3.14, 3.15, 3.16, #2433): the function, the new fields,
   the page drawing only returned acts with one main act per line, bold lines,
   required marks. No server behaviour or rule changes, so it ships under
   option A or B and doesn't wait on the central decision.
3. **One-act PR** (central question, 3.29): the approve service fills the seat
   and admits the Board stand-in; B2's approval-only act; the rule edits in the
   same PR. Waits on your answer to open question 1.
4. **Approve All PR** (3.13): the batch route and button. After steps 1 and 3.
5. **Pill and landing PR** (3.25): the badge from the function and the "Waiting
   on you" view. Coordinate with #2492.
6. **Back to the queue PR** (3.12): after #2482's expense detail PR, so the two
   share one helper.
7. **Submitter seat PR** (#2432): after open question 2. The attestation, the
   seat recorded at expense creation, the rule edit, and whatever you decide for
   expenses already waiting.
8. **Override rule** (3.17): the rule text, in step 3's PR or on its own. Code
   changes only if you add the Treasurer bar (open question 3).

## How each item is resolved

| # | Finding | Resolution | Step |
| --- | --- | --- | --- |
| 3.12 | Page reloads in place after the last decision | Returns to the approvals list when the caller has no act left, per #2482's rule (§9) | 6 |
| 3.13 | Approve All gone | One all-or-nothing request over the caller's approvals; never overrides (§4) | 4 |
| 3.14 | Own pending lines not bold | Lines with a main act for the caller are bold with an arrow, with a count in the heading (§5) | 2 |
| 3.15 | Approve and Raise exception shown to everyone | Only acts the server computes for the caller are drawn (§1) | 2 |
| 3.16 | Override comment required only on the server | `commentRequired` marks the field and disables Confirm (§6) | 2 |
| 3.17 | Only FINANCE overrides; no rule | Proposed rule: keep, with a reason, settling the approval only (§7) | 3 or own |
| 3.25 | Pill counts seats, page opens on approval | One act, one count, a "Waiting on you" view (§8) | 5 |
| 3.29 | Seats, Board holds, backfill, org-level pre-approval, conflicts are new | Each has a defined action or status (§10, B.2 to B.6) | 2, 3 |
| #2432 | Submitter can't sign | Submission attestation fills the seat (§3) | 7 |
| #2433 | Sign-as shown to people who can't sign | Same as 3.15; other seats show as status (§1) | 2 |
| #1272 | No rule for the override | As 3.17 | 3 or own |

## Open questions

1. **One act or two?** The recommendation is B: approval and the
   program-approver seat as one act, with B2 for a non-member reimbursee (the
   bucket approver approves, the Board member signs). B1 would drop the bucket
   approver's check on that line. It touches a rule citing Financial Policy
   Art. IX §IX.2, so it needs escalating if you prefer it. Do you accept B with
   B2?
2. **The submitter's seat.** S2 makes submission the signature, through an
   attestation on the receipt form. Does an attestation at submission satisfy
   Financial Policy Art. IX §IX.3's signature, checked against the policy on
   Drive? And for expenses already waiting with an empty submitter seat: should
   each submitter sign once from their receipt page (S1, for those only), or do
   you have another way in mind?
3. **The override and the Treasurer seat.** The rules bar whoever approved a
   line as its program approver from the Treasurer seat. Should a finance holder
   who overrides the approval be barred from the Treasurer seat on that line
   too? The code doesn't bar them today.
4. **Where Treasurer and Board seats are counted.** This design counts the
   program-approver act on the approver pill. Should signatures waiting on
   FINANCE and the Board get a "To sign" tab in #2482's finance queue, with
   Approve All's equivalent for the Treasurer?
5. **A silent approver.** The rules let the Board stand in when approvers are
   "conflicted or unavailable". The app reads "unavailable" as an owner who is
   merged away or whose membership blocks sign-in. An approver who is eligible
   but doesn't act holds the line indefinitely, and an override doesn't release
   the money. Is that intended, or should finance be able to mark approvers
   unavailable?
6. **One field with #2482.** `commentRequired` on the override act and #2482's
   planned `overrideRequired` describe the same fact. Which design owns it?

#2483's two open questions (a flag for a Board stand-in in the program-approver
seat, and whether past signers are re-checked in the stand-in count) bear on B.2
and stay open there.

## Appendix: provenance

Design for #2501. Items from the receipt-flow conversion audit, Stage 3 and
theme 4: 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.25, 3.29. Open issues: #2432,
#2433, #1272. Related: #2482 (finance exception queue, design for #2481), #2224
(rule additions), #2483 (rule corrections and open questions), #2492 (queue
counts).

The Inventory2 prototype had owner approval only, with no seats. It offered
Approve All to budget owners, bolded and arrowed their pending lines, required
an override comment from finance, and returned to the owner-approval view after
the owner's last decision.
