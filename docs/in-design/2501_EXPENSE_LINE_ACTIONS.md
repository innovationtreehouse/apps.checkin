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

- **Owner approval is the program-approver sign-off** (decided, C′ below), as
  in the Inventory prototype. A line meets the program-approver requirement
  when its approval is `approved`, and the approval row records who approved
  it and when. The separate program-approver seat, its signatures and its
  button go. The submitter and Treasurer seats stay as signatures.
- **A non-member reimbursement adds a Board approval after the bucket's
  approval** (decided). The bucket approver approves the line as for any line,
  and then a Board member without a conflict signs a Board seat.
- **The server tells the page what the caller may do** on each line, computed
  by the same function that refuses a click. The page draws only those actions,
  and every other open seat shows as "Awaiting Treasurer" and the like (3.15,
  #2433).
- **A reimbursement's submitter signs by confirming the receipt as read**
  (decided): a required check-off of the lines and amounts, before the receipt
  goes to finance, whatever the intake path. A card charge takes no submitter
  signature (#2432).
- **Approve All comes back**, as one all-or-nothing request (3.13). Lines waiting
  on the viewer are bold with an arrow (3.14). A required comment is marked, and
  Confirm stays disabled until it's written (3.16). The page returns to the
  approvals list after the viewer's last action (3.12).
- **The approver pill and its page agree**: both count lines with an action for
  the viewer, and the pill opens a "Waiting on you" view (3.25).
- **The FINANCE override goes** (decided, 3.17). Only a line's bucket
  approvers approve it, or a Board member without a conflict, who may step in
  on any line at any time. A finance holder who is also a bucket approver
  approves that bucket's lines as an approver.
- **What doesn't change**: each signer is a different person from a different
  household; the conflict rules; the Board stand-in limits; the Board's
  authorization and the $2,000 hold; the approval row's statuses and finance's
  exception queue (#2482).
- **Cost**: one boundary PR and seven feature PRs, one of them the C′ change
  with a data-only migration. No schema change.

## Rules this relies on or changes

From `docs/rules/expenses.md` on `main`, with each line's tier. Lines #2224
adds are marked as proposed.

| Rule (short form) | Section and tag | Under this design |
| --- | --- | --- |
| Spending sign-off is governed by Financial Policy Arts. IX and XII and Procurement Policy Art. IV | **Policy** | Unchanged. Every line below cites it, so check each change against the policy on Drive |
| A conflicted person may not approve a line, raise an exception, sign any seat, or record Board authorization | Procedure, `[Decision — Policy: Ethics Policy Art. III §III.5]` | Text unchanged. Approving also takes the seat's refusals, so it gets stricter (C′.2) |
| Each line is signed by the submitter, a program approver and the Treasurer: three people, three households | Procedure, `[Decision — Policy: Financial Policy Art. IX §IX.3]` | **Changes** (decided): the program approver's part is the line's approval, not a seat signature (C′.1). The submitter signs a reimbursement by confirming its receipt; a card charge takes the program approver and the Treasurer only (§3). Each signer stays a different person from a different household. The line splits in two: reimbursements keep the §IX.3 citation, which covers reimbursements only, and card charges become `[Decision — owner]` |
| A bucket's approvers are its owner and treasurers; an org-level bucket has none | Procedure, `[Decision — owner]` | Unchanged. A new line says the approval is the program approver's sign-off |
| A conflicted Treasurer does not sign; the conflict includes having approved the line as its program approver | Procedure, `[Decision — Policy: Financial Policy Art. IX §IX.3; Ethics Policy Art. III §III.5]` | Text unchanged. Under C′ "approved the line as its program approver" is the approval row, and the code reads it from there. There is no FINANCE override, so no other approval needs reading (open question 3, decided) |
| When every bucket approver is conflicted or unavailable, a Board member signs the program-approver seat | Procedure, `[Decision — owner]` | **Changes** (decided): a Board member without a conflict may approve any line in place of its bucket approvers, whether or not they can act. Replaced below. You decided the Board stand-in replaces the program approver's signature (open question 10) |
| Reimbursing a non-member takes a Board member in the program-approver seat | Procedure, `[Decision — Policy: Financial Policy Art. IX §IX.2]` | **Changes** (decided): the program approver is chosen as for any line, and the reimbursement also takes a later Board member's approval, in a Board seat signed after the line is approved. The §IX.2 citation stays. This changes the app's reading of the policy, not the policy: §IX.2 requires Board approval and doesn't stop the program approver approving too |
| The submitter's audience may reach a sign-off for the submitter seat, "since that seat is filled from the receipt" | Procedure, `[Decision — owner]` | **Changes**: the seat is filled from the confirmation of a reimbursement's receipt by the person reimbursed, and a card charge has no submitter seat. Reworded below |
| Proposed in #2224: finance decides each line's bucket before the program approver signs | Procedure, `[Decision]` | Consistent |
| Proposed in #2224: a line in an org-wide bucket takes a Board member as program approver; at most two Board substitutions on a reimbursement line, one on a card charge | Procedure, `[Decision]` | Consistent. The org-level line's Board member approves the line instead of signing a seat, so the line is no longer pre-approved at intake (C′.4) |

No Policy-tier line changes. Four Procedure lines that cite a policy are
touched. The conflict line, the three-signatures line and the
Treasurer-conflict line keep their substance; approving gets stricter. The
non-member line changes the app's reading of Financial Policy Art. IX §IX.2, as
you decided, and keeps its citation. The three-signatures line splits in two.
Financial Policy Art. IX §IX.3 covers reimbursements only, so the
reimbursement line keeps that citation, and the card-charge line, which takes no
submitter signature, is your decision and cites no policy.

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

## Decided: owner approval is the program-approver sign-off (C′)

Owner approval and the program-approver seat are asked of the same people (the
bucket's owner and treasurers), about the same line, on the same page. Today
they are separate records. Owner approval moves the expense through its states:
when every line is approved, the expense goes to capital review or to the books
queue, and an exception goes to finance. The seat holds money back: a line with
an open seat keeps the expense from posting, whatever its state.

You decided that the approval and the state machine that runs on it *are* the
program-approver sign-off, as in the Inventory prototype. There is no separate
program-approver signature.

### What C′ means, case by case

**C′.1 The posting gate reads the approval.** A line meets the program-approver
requirement when its approval is `approved`. The approval row already records
who decided it and when, and that is the program approver's signature. The
submitter and Treasurer seats stay as signatures, and so does the Board seat. The
approval row keeps all its statuses, and finance's exception flow is unchanged.

**C′.2 Approving takes over the seat's refusals.** Today an approval is refused
only to the submitter, the reimbursee and their households. Under C′ it is also
refused when the approver's household already holds a seat on the expense, or
when the approver has signed the Treasurer seat on that line. The reverse holds
too: whoever approved a line doesn't sign its Treasurer seat. That closes a gap
in today's code: a bucket treasurer who is also FINANCE can approve a line and
then sign it as Treasurer. The approver counts as seated on the expense, so
their household holds no other seat on it.

**C′.3 A Board member may always step in.** You decided that a Board member
without a conflict may approve any line at any time, in place of its bucket
approvers, not only when every approver is conflicted or unavailable. There is
no step to mark an approver unavailable. The bucket approvers keep their act,
and the line counts as approved by whichever eligible person approves first.
Every approval refusal applies to the Board member too: their household, other
seats on the line, and the Treasurer bar. A Board approval of a line in a
Board-approved program budget is recorded as a Board stand-in, so the audit
shows who approved in place of the bucket's approvers, and the Board member
gives a reason with it (§6). It counts as a
substitution under the existing stand-in limits, as a Board member's seat
signature does today.

**C′.4 Org-level bucket.** Today the approval is pre-approved at intake, because
the bucket has no approvers, and a Board member signs the seat. Under C′ a
pre-approval would meet the requirement with no one's judgment. So an org-level
line starts pending, and a Board member without a conflict approves it, as for
any line whose approvers can't act. Because an org-level line has no bucket
approvers to stand in for, the Board member gives no reason (you decided this;
§6). The expense then waits in owner approval for that Board member. A backfilled expense stays pre-approved, because it takes no
sign-off at all.

**C′.5 After finance reassigns a line.** Today, when FINANCE settles an exception
by moving the line to another bucket, the approval closes as finance-assigned,
and nobody in the new bucket approves it. Under C′ that line would have no
program approver. So a finance-assigned line waits for an approver of its new
bucket, who approves it as they would a pending one. The status keeps its name
and stays in the audit trail, but it stops counting as a finished approval.
You decided this (open question 7): finance's assignment never counts as the
approval.

The new bucket's approver may raise "not mine" again on a moved line, and
finance settles it as before. You also decided that finance may mark a bucket
assignment **final**. After that, no further exception can be raised on the
line, and the bucket's approver, or a Board stand-in, approves it. In your
words: "At some point finance has to be able to say 'I don't care what the
program owner thinks'." A final assignment is the last word on the bucket, not
an approval: the line still waits for its approver, and the decision that
finance never approves a line (§7) stands. Marking an assignment final is
audited with the assignment, and Raise exception leaves the line's actions once
it is final.

**C′.6 Non-member reimbursement.** You decided that the Board's approval is
added, not substituted, and comes after. The bucket approver approves the line
as for any other line. Then a Board member without a conflict signs a Board
seat, which the server refuses until the line is approved. The Board signer is a
fourth person, from a fourth household. Financial Policy Art. IX §IX.2 requires
Board approval for reimbursing a non-member and doesn't stop the program leader
approving too, so this is a `[Decision]`-tier change to how the app reads the
policy.

**C′.7 Timing.** The approval is recorded only while the expense waits for owner
approval, as today. The early program-approver signature during bucket
assignment goes with the seat, so the approve and bucket-assignment services
need no change for timing.

**C′.8 No FINANCE override.** You decided to remove it: finance has no approve
act on a line outside its own buckets. See §7.

**C′.9 Signatures in order.** You decided that a line's signatures happen in
order, as the Inventory prototype did, so no later step can create a problem
for an earlier one. The order follows Financial Policy Art. IX §IX.3's list:

1. the person reimbursed confirms the receipt (reimbursements only);
2. the line is approved, by a bucket approver or a Board stand-in;
3. the Treasurer signs;
4. any Board signature the line takes: the Board seat on a non-Everyday card
   charge without Board authorization, or on a non-member reimbursement.

The server refuses a later signature until the earlier ones exist, and the
line-actions function offers only the next one. Today's sign-off service lets
any seat be signed at any time while the expense is open; that changes. The
Board's approval of a purchase of $2,000 or more is recorded, not signed, so it
isn't a step in this order. The order is strict, as you decided (open question
11): a Board signature is refused until the Treasurer has signed the line.

Because the approval comes before the Treasurer, and finance can move a line
only before it is approved (bucket assignment, an unknown bucket, or an
exception raised), no Treasurer or Board signature exists when a line moves. A
move needs no seat voiding, and the conflict in open question 8 can't arise.

**Going back clears what follows** (open question 12, decided). Whenever an
earlier step is cleared or has to be given again, every later step is cleared
too, and they are given again in order. That covers every later step in the
expense's state machine, not only signatures: when an expense returns to an
earlier state, capital review and the depreciation cycle are done again as
well. For example:

- A finance change to a confirmed reimbursement clears the submitter's
  confirmation (§3), so the line's approval returns to pending and its
  Treasurer and Board signatures are deleted.
- An approval that reopens, for example when a line moves after an exception,
  clears the Treasurer and Board signatures.
- An expense that returns to owner approval from capital review, the
  depreciation cycle or the books queue clears its capital-review and
  depreciation decisions, and finance makes them again once every line is
  approved.

Each clearing is audited, one row per cleared signature, approval or capital
and depreciation decision, naming what cleared it. A Board authorization or the Board's recorded approval of a
$2,000 purchase is a record, not a signature, so it stays. When a cleared
approval belongs to an expense that has moved past owner approval, the expense
returns to owner approval, which the state machine needs a new transition for.

### What is deleted, and what moves

| Today | Under C′ |
| --- | --- |
| The `PROGRAM_APPROVER` seat in the seat list, its sign-off rows, and its share of the seat refusal and the stand-in rule | Deleted. The stand-in rule moves to the approval: who may approve is the bucket's approvers or any Board member without a conflict, a Board approval counting within the substitution limit (C′.3) |
| The rule that sends the program-approver seat to the Board for an org-level bucket or a non-member | Deleted. Org-level lines take a Board member's approval (C′.4); non-member lines take a Board seat after approval (C′.6) |
| Sign as Program approver, and its "Waiting for Finance to assign a budget bucket" note | Deleted from the page |
| The approver pill's count of open program-approver seats | Replaced by a count of lines the caller may approve (§8) |
| Voiding the seats on a line whose bucket changes, in the three bucket-assignment services | Deleted, as you decided. With signatures in order (C′.9), a line moves only before any Treasurer or Board signature exists, so nothing needs voiding |
| Seat conflict checks: the household already seated, another seat on the line, the Treasurer exclusion | Move into the approve service and the line-actions function (C′.2); the Treasurer-seat refusal reads the approver from the approval row |
| The catalog snapshot and the drain that run when the last seat is signed | Also run when the approval meets the last requirement |
| Org-level pre-approval at intake and at bucket assignment | Deleted; org-level lines start pending (C′.4) |
| A finance-assigned approval counting as finished | Deleted; the line waits for its new bucket's approver (C′.5) |
| The Board seat, today only on a non-Everyday card charge | Also on a non-member reimbursement line, signable only after approval (C′.6) |

### Migration

There are no live receipts in production, so nothing there needs moving. The
C′ PR carries one data-only migration: it deletes every `PROGRAM_APPROVER`
sign-off row, which would otherwise count as a seated signer, and leaves their
audit rows as history. The seat column is plain text, so there is no schema
change. Open expenses on the dev instance with an org-level line pre-approved,
or a finance-assigned line, keep those approvals; resetting the dev data is
simpler than migrating them.

### Why not B or C

The earlier draft recommended **B**: one click writing both the approval and a
seat signature. It kept two records of one judgment, and they could still drift
apart wherever one was written without the other, such as a reassignment.
**C** retired the approval's "approved" status and had the state machine wait
on the seat. It needed a schema change and a state-machine change for no
visible gain. C′ keeps the record the state machine already uses and drops the
duplicate.

## Design

### 1. The server says what the caller may do

The sign-off status the page already loads gains, on each line, the acts this
caller may take there:

| Field | Meaning |
| --- | --- |
| `actions[]` | Each act the caller may take now: `approve` (the program approver's sign-off, by a bucket approver or a Board stand-in), `sign` (Treasurer or Board), `raise-exception`, `reject-exception`, `assign-bucket`, `resolve-bucket` |
| `actions[].primary` | True on at most one act per line |
| `awaiting[]` | Open seats and holds the caller can't act on, as plain status: "Awaiting Submitter", "Awaiting approval", "Awaiting Treasurer", "Awaiting a Board stand-in", "Board approval after the line is approved", "Held: no one without a conflict can sign", "Held until finance names the reimbursee", "Held until the Board's approval is recorded" |

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
Program approver", "Sign as Treasurer", "Sign as Board", "Approve as Board
(program approver)". Other acts go in a "More" menu on the same line: Raise
exception, and any other part the caller could take instead.

When the caller could take more than one part on a line (a bucket owner who
holds FINANCE, or a Board member eligible for the Board seat and as a stand-in),
taking one rules out the others, because one person takes one part per line.
The main act is the part with the fewest other people available to take it,
ties going approval, then Treasurer, then Board. So the button asks the caller
for the part that is hardest to fill without them.

On a line with an exception raised, FINANCE's main act is Assign bucket, with
Reject exception in More. Those screens belong to #2482; this design only gives
them the same `actions` field.

### 3. The submitter's seat (#2432)

You decided this by the kind of line. The submitter never sees the expense
page, so in both cases the decision happens on the receipt.

**A reimbursement: the person reimbursed confirms the receipt as read.** The
signature is the check-off, by the person the reimbursement pays, of the receipt's lines and amounts as the app
holds them, after OCR or entry and before the receipt goes to finance. It is
required every time, whatever the intake path; submitting alone doesn't count,
because OCR can misread a receipt, and the submitter's own money depends on it.

The receipt library already has this step. A receipt read by OCR or mailed in
waits for its uploader's review, and the receipt machine sends every
reimbursement there too, whatever the path (audit finding 1.14). So a manual
upload reaches the same confirmation: after the submitter enters the receipt,
it waits in submitter review until they confirm it, as an OCR-read one does.
The review screen becomes the signature:

- It shows the lines and amounts as read, and the confirm button reads "These
  lines and amounts are right" in place of a plain Confirm.
- The person reimbursed confirms, not the uploader, where the two differ (you
  decided this). Any named reimbursee may confirm, whatever their membership;
  reimbursees are adults only. When the person reimbursed has no account, a
  Board member confirms on their behalf and must give a reason; the field is
  required, the button stays disabled while it is blank, and the server refuses
  a blank one. The reason is stored and audited with the confirmation.
- No sign-off of any kind, confirmation, approval or signature, is possible
  until the person reimbursed is known (you decided this). Today's refusal of
  a signature while the reimbursee is unknown extends to the confirmation and
  the approval.
- The confirmation records who confirmed and when. The receipt-to-expense
  contract carries it, alongside the review outcome theme 2 adds, and when the
  expense is created the app records the submitter seat on every line, signed
  by whoever confirmed and citing that confirmation. The seat comes only from
  the confirmation: the generic sign-off route refuses `SUBMITTER`.

**A finance change sends a reimbursement back to the submitter** (decided).
Once a reimbursement is confirmed, a change finance makes to what was claimed
or what is paid voids the confirmation, and the person reimbursed confirms
again before the expense can post. The
changes that count:

- line items: adding, removing or editing a line;
- amounts: a line's quantity, unit price or total, and the receipt total;
- tax, shipping and discount;
- the currency;
- the receipt date;
- the reimbursee.

Finance's bookkeeping doesn't count, as you decided (open question 9): which
bucket a line is charged to, the QuickBooks account set on a hold, and the
capital or depreciation designation. Nor does a change to the retailer, which
you also decided. None of them changes what the submitter
claimed or what they are paid.

Where the change lands depends on how far the receipt has gone:

- **Before the receipt is finalized** (finance review), the change clears the
  confirmation, and the receipt machine's existing guard sends it
  back to submitter review when finance approves it, as it does any
  reimbursement not yet confirmed.
- **After the expense exists**, the change deletes the submitter seat on every
  line, and with it every later signature: each line's approval returns to
  pending, and its Treasurer and Board signatures are deleted (C′.9). The
  posting gate then holds the expense, as for any missing seat, and
  the receipt shows on the submitter's My receipts page as "Finance changed
  this receipt; confirm it again", with the changed fields marked.

Either way the receipt is back in the queue of the person who confirms it, and
their My receipts pill counts it: the pill counts receipts in submitter review
today, and it also counts reimbursements whose expense is waiting for a new
confirmation. A Board member's pill counts a confirmation on someone's behalf
only where the Board is the only one who can act: the person reimbursed has no
account. Confirming again records the seat on every line, as at creation.

Every act is audited: each void as `signoff_voided` on its line, naming the
finance holder, the change and the fields it touched, with the cleared approval
and later signatures audited the same way, and the new confirmation
as its own audit row on the receipt and the seat on the expense. A card charge
is unaffected; finance corrects it without the submitter.

**A card charge: no submitter signature.** A card charge doesn't touch the
submitter's money, so finance may correct the receipt and the submitter
approves nothing. The submitter seat isn't required on a card-charge line, and
the line takes the program approver and the Treasurer. A mailed or OCR-read card
charge still waits for its uploader's review, as today, because that step also
asks for details the read can't supply, but confirming it fills no seat.

A backfilled expense takes no sign-off, so it records no seat.

### 4. Approve All (3.13)

When the caller's main act is an approval on two or more lines of the expense,
a button above the table reads "Approve all 4 as Program approver". It sends one request, which checks every line
with the same function under the expense lock and approves all of them or none.
If any line is refused, nothing changes and the error names the line. A partial
batch would leave the approver unsure which lines still wait. A Board member's
Approve All covers only lines where their approval is the main act: where the
Board is the only one who can act (C1, §8).


### 5. Lines waiting on you (3.14)

A line where the caller has a main act is bold, with an arrow beside its number,
as in the prototype. The heading says how many: "3 of 7 lines wait on you." Line
order stays by line number, which matches the receipt.

### 6. Required comments (3.16)

3.16 was about the override comment, which is moot now that the override is
gone (§7). Raise exception and Reject exception still require notes. Their
fields are marked required, and Confirm stays disabled while they are blank, as
#2482 §4 sets for finance's notes. The server's refusal stays as the backstop.

A Board member approving a line in place of its bucket approvers (C′.3) must
give a reason, as you decided. The field is marked required, the approve
button stays disabled while it is blank, and the server refuses a blank one.
The reason is stored on the approval and written to its audit row. A Board
member who approves a line as an approver of its own bucket gives no reason,
and neither does one who approves an org-level line, which has no bucket
approvers to stand in for (C′.4). A Board member confirming a reimbursement
for someone with no account gives a reason the same way (§3). No other
approval or signature takes one.

### 7. No FINANCE override (3.17)

The prototype had an org-manager role that approved without a comment. FINANCE
replaced that role, and approves outside its own buckets only with a comment.
No rule covers that. You decided to remove the override: "board yes finance no".

Only a line's bucket approvers approve it, or a Board member without a
conflict, who may step in on any line at any time (C′.3). A finance
holder who is also a bucket's owner or treasurer approves that bucket's lines
as an approver, under the normal approval refusals. Finance keeps its
exception tools: it can move a line to another bucket, which then waits for the
new bucket's approver (C′.5), or reject the exception. Neither counts as an
approval.

The approve service loses its finance branch, and the page loses the override
dialog. A line whose approver is eligible but silent is unblocked by any Board
member without a conflict (open question 5, decided).

### 8. The pill and its page agree (3.25)

The approver pill counts lines the caller may approve. It uses the same
function and the badge's existing cap of 25 expenses. Under C′ the approval is
the program-approver sign-off, so that one number covers both.

The pill opens Programs I Lead › Expense approvals on a new default view,
"Waiting on you": expenses with at least one such line. Owner approval stays a
view for browsing. The list prefilters in the database as the badge does
(the caller's buckets, approval pending, not their own receipt) and then applies the
function, so the list and the pill always agree.

Open PR #2500 (for #2492) adds per-queue counts, and they are a different
measure. Its owner-approval count counts expenses, not lines, and leaves out
only expenses the viewer is conflicted on as submitter or reimbursee, or a
member of either household. So it differs from this pill. That count
is the one that changes: step 5 moves it onto the same function, refusing
everything an approval refuses under C′, and keeps it per expense because it labels an
expense-list view. The pill stays per line. Both then come from one rule and
only the unit differs. #2500's QB-pending count already counts expenses with an
open Treasurer, Board or Board-substituted program-approver seat the viewer can
fill; under C′ its program-approver part goes, because a Board stand-in approves
in owner approval before the expense is QB pending. Its Treasurer and Board
seat counts move to Finance review (below). Treasurer and Board seats stay off
this pill.

A Board member may approve any line (C′.3), but their counts don't include
every pending line, or the Board would always see the whole queue. A Board
member's pill counts a line only where the design already counts Board items:
#2482's Board tab, as "Approval needs a Board member", for a line no bucket
approver can approve (every approver conflicted or unavailable, or an
org-level bucket). The line-actions function gives that condition. On the
expense page a Board member still sees "Approve as Board (program approver)"
in More on any line they may approve, and as the main act only on a line no
bucket approver can approve.

You decided this generally (C1): a Board member's stand-in approval is a
secondary act. It is the main act, and counts in pills, in "Waiting on you"
and in Approve All, only where the Board is the only one who can act, or for
the Board's own seat. Everywhere else it stays in More and is counted
nowhere.

**Treasurer and Board signatures in Finance review** (open question 4,
decided). The signatures FINANCE and the Board give get screens of their own in
#2482's Finance review queue.

- **To sign tab:** lists the lines waiting for a Treasurer signature that this
  viewer may give, and only those whose earlier steps are complete: the
  submitter's confirmation on a reimbursement, and the approval (C′.9). It
  lists them one row per expense with the count of such lines, opening
  the expense page. A "Sign all N as Treasurer" button, the Treasurer's
  equivalent of Approve All, signs every listed line on that expense the
  viewer may sign, in one all-or-nothing request under the same per-line
  refusals as a single signature.
- **Board tab:** lists the lines waiting for a Board signature this viewer may
  give, again only once the earlier steps are complete, so only after the
  Treasurer has signed the line: the Board seat on a non-Everyday card charge without Board
  authorization, the Board seat on a non-member reimbursement once the line is
  approved, and the Treasurer seat when no finance holder without a conflict
  can sign it. The Board's approval of a purchase of $2,000 or more is
  recorded, not signed, and #2482 already lists it in this tab.
- **Counts:** both tabs count only lines the viewer may sign, from the same
  line-actions function, and both feed the Finance review pill. A Board member
  sees the Board tab's count; a finance holder sees both.

This design specifies what each tab lists and how a row is signed. #2482
specifies the tabs' place in the queue, the row layout and how the pill sums
them. To keep any seat from being counted twice, step 9 removes the Treasurer,
Board and Board-substituted seat parts from #2500's QB-pending count in the same
PR that adds the two tab counts. #2500's QB-pending count keeps only what isn't
a signature: an unknown reimbursee and a Board authorization to record.

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
| Org-level bucket pre-approval | No longer pre-approved; a Board member's main act is "Approve as Board (program approver)" (C′.4) |
| Sign-off seats | One main act per person, with open seats shown as status (§1, §2) |
| Board seat (non-Everyday card charge without Board authorization, and now a non-member reimbursement) | "Sign as Board" for an eligible Board member; on a non-member line only after the approval, with "Board approval after the line is approved" as status before then (C′.6) |
| Board approval hold ($2,000) | Status "Held until the Board's approval is recorded"; the act is the Record Board authorization panel, shown only when `mayRecordBoardAuthorization` is true (#2482 handles the Board's queue for it) |
| Conflict refusals | Computed into `actions`, so a conflicted act is never drawn |
| Board stand-in limits | Computed the same way. A line past the limit shows "Held: no one without a conflict can sign" |

## Proposed rule text

To land in `docs/rules/expenses.md`, Spending sign-off. Every line follows from
a decision you made:

- A line's program approver signs it by approving it: the approval records who
  approved and when, and no separate signature is taken. Whoever may not hold a
  seat on the expense may not approve the line, and whoever approved a line
  does not sign its Treasurer seat. *(new line, after the three-signatures line)*
  `[Decision — owner]`
- A Board member without a conflict may approve any line in place of its
  bucket approvers, giving the reason. A Board member approving a line in an
  org-level bucket, which has no bucket approvers, gives none. *(replaces the existing line about every owner and
  treasurer being conflicted or unavailable)* `[Decision — owner]`
- Reimbursing someone who is not a Treehouse Member takes the program approver
  chosen as for any line, and then a Board member's approval. A Board member
  without a conflict signs a Board seat on each line once the line is approved.
  What counts is the person reimbursed, not whoever submitted the receipt, and a
  card charge is not a reimbursement. *(replaces the existing line; keeps*
  `[Decision — Policy: Financial Policy, Art. IX §IX.2]`*)*
- A reimbursement reaches the books only once each of its lines is signed by
  the person reimbursed, by confirming the receipt; by a program approver, who is an
  owner or treasurer of the line's bucket, or, for a line outside a
  Board-approved program budget (an org-level bucket), a Board member without a
  conflict who is not the Treasurer; and by the Treasurer. Every signer is a
  different person from a different household. *(replaces the
  three-signatures line for reimbursements)*
  `[Decision — Policy: Financial Policy, Art. IX §IX.3]`
- A card charge reaches the books only once each of its lines is signed by a
  program approver, chosen as for a reimbursement, and the Treasurer, two
  different people from different households. The submitter does not sign a
  card charge. *(replaces the three-signatures line for card charges; the
  policy does not address card charges)* `[Decision — owner]`
- The person reimbursed signs a reimbursement by confirming its receipt as
  read, its lines and amounts, before the receipt goes to finance, whatever the
  intake path. Submitting the receipt is not the signature, and the signature
  comes from nothing else. Any named reimbursee may confirm, whatever their
  membership; reimbursees are adults only. When the person reimbursed has no
  account, a Board member without a conflict confirms on their behalf, giving
  the reason. Finance may correct a card charge's receipt without the
  submitter. *(new line)* `[Decision — owner]`
- No confirmation, approval or signature is given on a reimbursement until the
  person reimbursed is known. *(new line)* `[Decision — owner]`
- Once a reimbursement is confirmed, a change finance makes to what was
  claimed or what is paid voids the confirmation: its line items, a line's
  quantity or unit price, tax, shipping, discount, the total, the currency, the
  receipt date, or the person reimbursed. The reimbursement does not reach the
  books until it is confirmed again. Neither finance's bookkeeping nor the
  retailer voids it: a line's bucket, the accounting-system account set on a
  hold, the capital or depreciation designation, or the retailer's name. The void and the new confirmation are both recorded.
  *(new line)* `[Decision — owner]`
- *(audience line)* replace "since that seat is filled from the receipt" with
  "since that seat is filled by the confirmation of a reimbursement's receipt
  by the person reimbursed". *(same tag)*
- Only a bucket approver, or a Board member without a conflict in their place,
  approves a line. *(new line)* `[Decision — owner]`
- A bucket's approver may raise an exception on a line finance moved into
  their bucket. Finance may mark a line's bucket assignment final; after that,
  no exception can be raised on it, and the line still waits for its bucket's
  approver or a Board member in their place. A final assignment is not an
  approval. *(new line)* `[Decision — owner]`
- A line's signatures are given in order: the confirmation on a
  reimbursement, then the line's approval, then the Treasurer, then any Board
  signature the line takes. A signature is refused until the ones before it
  exist; a Board signature waits for the Treasurer's. *(new line)*
  `[Decision — owner]`
- When an earlier step is cleared or has to be given again, every later step
  is cleared and given again in order: later signatures, and, when the expense
  returns to an earlier state, its capital review and depreciation cycle. Each
  clearing is recorded. *(new line)* `[Decision — owner]`

## Routes and the security registry

| Item | Change |
| --- | --- |
| `GET /api/expense/expenses/[id]/signoffs` | Gains `actions` and `awaiting` per line and `mayRecordBoardAuthorization`. These describe the caller only, so they name no one else |
| `POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/approve` | Under C′, takes the seat's refusals and admits a Board stand-in |
| `POST /api/expense/expenses/[id]/line-items/[lineItemId]/signoffs` | Refuses `PROGRAM_APPROVER`, which leaves the seat list, and `SUBMITTER`, which comes only from the confirmation; the route and its registry entry are unchanged |
| `POST /api/expense/expenses/[id]/approve-lines` | New, for Approve All; `expense-approver`, with the library checking each line |
| `POST /api/expense/expenses/[id]/sign-lines` | New, for "Sign all N as Treasurer"; `finance-or-board`, with the library checking each line |
| `GET /api/expense/queue`, `GET /api/expense/expenses` | Accept the `awaiting_me` view; no new route |
| Receipt submitter review | The confirm admits the person reimbursed, or a Board member with a reason for someone with no account, and records who confirmed; the receipt-to-expense contract gains the confirmation, alongside the review outcome theme 2 adds |

The new fields on `ExpenseLineSignoffStatus` change a synthetic
classification, and the two new routes need registry entries. All ship in one
boundary-only PR on `main` before any feature PR, under the boundary isolation
rule. With no override, #2482's planned `overrideRequired` field isn't
needed either; #2482 is being told.

## Rollout

Each PR is based on `main`, not stacked.

1. **Registry PR** (boundary only): the new fields, and the `approve-lines` and
   `sign-lines` entries. Coordinate with #2482's registry PR A.
2. **Line actions PR** (3.14, 3.15, 3.16, #2433): the function, the new fields,
   the page drawing only returned acts with one main act per line, bold lines,
   required marks. No server behaviour or rule changes, so it can ship before
   step 3, computing today's acts, and step 3 updates the function.
3. **C′ PR** (central decision, 3.29): the posting gate reads the approval; the
   program-approver seat, its button and its seat voiding are deleted; the
   approve service takes the seat's refusals and admits a Board stand-in;
   org-level lines start pending; finance-assigned lines wait for the new
   bucket's approver; the Board seat on a non-member line, after approval. The
   sign-off service enforces the order of C′.9, where today it accepts any
   seat at any time while the expense is open, and clearing a step clears every
   later one, with the state machine returning an expense to owner approval
   when an approval reopens. The data-only migration and the
   rule edits ship in the same PR (C′.1 to C′.9).
4. **Approve All PR** (3.13): the batch route and button. After steps 1 and 3.
5. **Pill and landing PR** (3.25): the badge from the function and the "Waiting
   on you" view, and #2500's owner-approval count moved onto the same function
   (§8). After #2500 merges.
6. **Back to the queue PR** (3.12): after #2482's expense detail PR, so the two
   share one helper.
7. **Submitter seat PR** (#2432): the confirmation on the reimbursement
   review screen, carried to expense; the seat recorded at expense creation; no
   submitter seat on card-charge lines; voiding the seat on a finance change to
   a confirmed reimbursement, with the My receipts pill counting it; the rule
   edits.
8. **Override removal** (3.17): the approve service's finance branch and the
   override dialog go, with the rule line. It can ship in step 3's PR.
9. **To sign and Board tab content** (open question 4): the two tab lists and
   counts from the line-actions function, "Sign all N as Treasurer", and the
   seat counts removed from #2500's QB-pending count in the same PR (§8). After
   #2482's queue PR adds the tabs, and after steps 1 and 3; the batch-sign
   route needs a registry entry in step 1's boundary PR.

## How each item is resolved

| # | Finding | Resolution | Step |
| --- | --- | --- | --- |
| 3.12 | Page reloads in place after the last decision | Returns to the approvals list when the caller has no act left, per #2482's rule (§9) | 6 |
| 3.13 | Approve All gone | One all-or-nothing request over the caller's approvals (§4) | 4 |
| 3.14 | Own pending lines not bold | Lines with a main act for the caller are bold with an arrow, with a count in the heading (§5) | 2 |
| 3.15 | Approve and Raise exception shown to everyone | Only acts the server computes for the caller are drawn (§1) | 2 |
| 3.16 | Override comment required only on the server | Moot: no override. Raise and reject exception notes are marked required, with Confirm disabled while blank (§6) | 2 |
| 3.17 | Only FINANCE overrides; no rule | No override: only bucket approvers, or a Board stand-in, approve (§7) | 8 |
| 3.25 | Pill counts seats, page opens on approval | Approval is the sign-off, so one count, and a "Waiting on you" view (§8) | 3, 5 |
| 3.29 | Seats, Board holds, backfill, org-level pre-approval, conflicts are new | Each has a defined action or status (§10, C′.1 to C′.9) | 2, 3 |
| #2432 | Submitter can't sign | The person reimbursed confirms the receipt as read, which fills the seat; a finance change clears it and every later signature; a card charge takes no submitter seat (§3, C′.9) | 7 |
| #2433 | Sign-as shown to people who can't sign | Same as 3.15; other seats show as status (§1) | 2 |
| #1272 | No rule for the override | As 3.17 | 8 |

## Open questions

All twelve are decided or closed. The list keeps its numbers so review threads
still match.

1. **One act or two?** *Decided:* the line's approval is the program-approver
   sign-off (C′), and a non-member reimbursement takes the program approver as
   for any line plus a later Board member's approval (C′.6).
2. **The submitter's seat.** *Decided:* a reimbursement's submitter signs by
   confirming the receipt as read, every time; a card charge takes no submitter
   signature (§3). Financial Policy Art. IX §IX.3 covers reimbursements only,
   so it allows the card-charge case; that rule is your decision. A finance
   change to a confirmed reimbursement voids the submitter's signature, and they
   confirm again (§3).
3. **The override and the Treasurer seat.** *Decided:* there is no FINANCE
   override (§7). Only bucket approvers, or a Board stand-in, approve a line.
4. **Where Treasurer and Board seats are counted.** *Decided:* a To sign tab
   for Treasurer signatures, with "Sign all N as Treasurer", and Board
   signatures in the Board tab, both in #2482's Finance review queue and
   counted on its pill (§8). They move out of #2500's QB-pending count.
5. **A silent approver.** *Decided:* a Board member without a conflict may
   always step in and approve any line (C′.3). No step marks an approver
   unavailable.
6. **One field with #2482.** *Closed:* with no override, neither
   `commentRequired` nor #2482's `overrideRequired` is needed. #2482 is being
   told.
7. **A finance-assigned line.** *Decided:* finance can still move a line to
   another bucket, but the line then waits for the new bucket's approver
   (C′.5). Finance's assignment never counts as the approval.
8. **The Treasurer seat after a bucket move.** *Decided:* signatures happen in
   order (C′.9), so a line moves only before the Treasurer signs, and the
   conflict can't arise.
9. **Which finance changes send a reimbursement back.** *Decided:* only
   changes to what the submitter claimed or is paid (§3). A line's bucket, a
   hold's account, and the capital or depreciation designation don't.
10. **A Board member approving a program-budget line.** *Decided:* a Board
    stand-in replaces the program approver's signature, including on a
    reimbursement in a Board-approved program budget. Your reasoning: a
    program leader not signing amounts to the Board using its own authority
    over its policies, and the Board need not follow its policies to the
    letter in every case. You expect it to be very rare, and the required
    reason (§6) records each one. The rule is `[Decision — owner]` and cites
    no policy clause.
11. **The Board seat and the Treasurer.** *Decided:* the Board signature waits
    for the Treasurer's (C′.9).
12. **Re-confirmation and the order.** *Decided:* going back to any earlier
    step clears every later signature on the line, and they are given again in
    order (C′.9).

#2483's two open questions (a flag for a Board stand-in in the program-approver
seat, and whether past signers are re-checked in the stand-in count) bear on
C′.3 and stay open there. Under C′ the first becomes a flag for a Board member
who approves a line in place of its approvers.

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
