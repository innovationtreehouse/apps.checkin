# Purchase outcome email

## Problem

When a person buys something for the Treehouse and submits the receipt, they
learn what happened to it only by opening the app. Finance may reject the
receipt, with a reason; an expense line may be rejected; the expense may be
signed off and sent to the books. The app now shows each of these on the
person's receipt pages, and a rejected receipt waits in their My receipts pill
until they press "Got it". Nobody is emailed, so a person who doesn't check the
app finds out late, and a person waiting to be reimbursed has no word that the
money is on its way.

## Objective

When a receipt or its expense reaches an outcome, the people who can already
see that outcome in the app get one email saying so, with a link to the
receipt. The email tells them nothing the app would not show them.

## Executive summary

- **For the person who uploaded the receipt, and the person reimbursed when
  that is someone else:** one email each when finance rejects the receipt, when
  the expense ends with a rejected line, and when a reimbursement is signed off
  and sent to the books. Each email names the purchase by retailer and date,
  and links to the receipt.
- **For finance:** nothing changes in what they do.
- **Deliberately unchanged:** the in-app pill, "Got it", and the outcome steps
  stay as they are; the email adds no state the app tracks. An approver's
  exception, a gift's decision and receiving's progress send no email.
- **Cost:** two small outbox tables (one in the receipt library, one in the
  expense library), a host port in each, three or four email templates, one
  new preference, and a retry sweep on an existing cron. Three PRs, no boundary
  PR.

@thpr's decisions on the design's questions are [below](#decisions).

## Rules this relies on

From `docs/rules/expenses.md`:

- *A receipt finance rejected counts in its uploader's My receipts pill, with
  finance's reason, until the uploader acknowledges it on the receipt.* The
  email is additional to this and changes none of it.
- *Once a receipt is finalized, its uploader sees in the receipt pages what
  became of the purchase … The person reimbursed sees the same for a receipt
  someone else uploaded for them.* This fixes who may be told about an expense
  outcome.
- *The submitter sees only their own receipts, without donor or reimbursee
  names.* The uploader's email does not name the person reimbursed. The
  reimbursee's in-app view carries no uploader field, so their email does not
  name the uploader either.
- *Every mailed message that becomes a receipt gets one email
  acknowledgement … to the sender, and separately to the person the receipt is
  credited to … no acknowledgement is sent twice.* This is the nearest
  precedent: separate copies per person, each sent once.
- *Only the person who paid is reimbursed.* "The person reimbursed" below is
  always the receipt's named reimbursee.

From `docs/rules/principles.md`:

- *Least privilege: a surface grants nothing its gate does not already grant.*
  An email is a surface. The test is per field: the email may carry a field
  only if the recipient's in-app view of the same receipt carries it.
- *Fail closed: missing or ambiguous data resolves to the more restrictive
  reading.* A recipient with no usable address, or a lookup that fails, gets no
  email rather than a guess.
- *This codebase is not this organisation.* The email copy goes into the
  Board-editable template registry, not into code.

The design changes no existing rule. The rules it adds are under
[Rules to extract](#rules-to-extract).

## Decisions

@thpr answered the five questions on 2026-10-31: "q1 yes separately, q2 no,
q3 yea reimbursement only when sent to the books, q4 yes new preference on by
default, q5 no reason or total in email". Numbers are fixed IDs.

| # | Question | Decision | @thpr, 2026-10-31 |
|---|---|---|---|
| Q1 | Who gets each email? | The uploader and, when different, the person reimbursed, as separate emails. | "q1 yes separately" |
| Q2 | Does an approver's exception email anyone? | No; only finance's settlement of it can produce an outcome email. | "q2 no" |
| Q3 | Does "complete" email at all? | Reimbursements only, when the expense is signed off and sent to the books. Card charges get no completion email. | "q3 yea reimbursement only when sent to the books" |
| Q4 | Opt-out | A new preference on the Communication page, "Email me about my receipts and reimbursements", on by default; the existing all-email opt-out also stops it. | "q4 yes new preference on by default" |
| Q5 | What may the email say? | The recipient's name, the retailer, the receipt date, the outcome and the link to `/receipts/<id>`. Neither finance's reason, nor a line's note, nor the total goes in the email; the recipient reads them in the app. Finance's reject forms are unchanged. | "q5 no reason or total in email" |

Two things follow from existing rules and need no answer:

- **No reimbursee without an account is emailed.** The recipient lookup is the
  one the mailed-receipt acknowledgement uses: a live person whose sign-in email
  is verified. A non-member reimbursee added by name has no verified address,
  and the link would lead to a sign-in they can't pass. (*Fail closed.*)
- **No name of the other party.** Under Q1-A, neither email names the other
  recipient (the rules cited above).

## Design

### Events

| Event | When it fires | Recipients (Q1-A) | Template |
|---|---|---|---|
| Receipt rejected | Finance rejects an open receipt, including one rejected as a duplicate copy | uploader; person reimbursed if different | `receipt.rejected` |
| Expense line rejected | The expense reaches its final `rejected` state, after every line has a final approval status | the receipt's uploader; person reimbursed if different | `expense.lineRejected` |
| Reimbursement complete (Q3-A) | A reimbursement expense reaches `qb_complete` | the receipt's uploader; person reimbursed if different | `expense.reimbursementComplete` |

The line-rejected email fires on the expense's final state, not on each line.
That matches what the app shows: a rejected line appears as "Line rejected" only
once the expense is closed, and one email covers every rejected line.
Sending on each line would email a person about an expense that is still moving.

`qb_complete` means the entry is queued for QuickBooks, not that the person is
paid. The completion email says the reimbursement is approved and with finance
to pay, and never that it has been paid.

A backfill (an old receipt finance imported for a purchase already in the
books) ends in `qb_skipped` and sends no completion email; nobody is waiting on
it. Finance skipping an expense in QuickBooks is a different thing: it changes
only the expense's QuickBooks match, after the expense has already reached
`qb_complete` and sent its email, so it sends nothing further.

All three final states are terminal in their state machines (`rejected` on the
receipt; `rejected`, `qb_complete`, `qb_skipped` on the expense), so each event
happens at most once per receipt.

### Where the owed email is recorded

Each library records an owed notice in the same transaction as the transition
that causes it, so a crash between the transition and the send loses nothing,
and a retry never creates a second notice.

- **Receipt library:** a `ReceiptOutcomeNotice` row, written by the finance
  reject path in the same transaction as the `REJECT` step.
- **Expense library:** an `ExpenseOutcomeNotice` row, written by whichever
  transition moves an expense into `rejected` or `qb_complete`, in that
  transition's transaction. Card charges are recorded too
  but marked as owing nothing under Q3-A, so a later change of answer needs no
  backfill.

Each row holds the receipt id, the event, and per-recipient send stamps
(`uploaderSentAt`, `reimburseeSentAt`), plus `claimedAt` and `attempts`, the
same shape as `ReceiptMailReply`: claim before sending so a send is never
repeated, clear the claim only after a send that reported failure, give up after
a fixed number of attempts. A row is unique on (receipt id, event).

Because rows are written at the transition, receipts rejected and expenses
closed before the feature ships have none, and nobody gets an email about an
old outcome. No cutover step is needed.

### Sending

Each library declares a port in its `contract.ts`, following `ReceiptReplies`:

```ts
/** The host's mail out, for purchase outcomes. */
export interface OutcomeMail {
  /** Sends one notice to one recipient; false when it was not delivered. */
  send(notice: OutcomeNotice, to: "uploader" | "reimbursee"): Promise<boolean>;
}
```

The library calls it right after the transaction commits, best effort, and the
daily sweep retries anything still owed. The receipt sweep runs where
`readMailbox` already runs; the expense sweep runs on the `qbo-posting` cron.
Unset, the port leaves notices owed, as an unbound `replies` port does.

The host binds both ports in `lib/receipt/configure.ts` and
`lib/expense/configure.ts` to one function in a new
`lib/purchaseOutcomeMail.ts`, which:

1. Resolves the recipient from the receipt: `uploadedByUserId` or
   `reimburseePersonId`. The reimbursee copy is owed only when that person
   differs from the uploader.
2. Looks the person up as `contactOf` does (live, sign-in verified). No
   address: the copy is done, not retried.
3. Reads `notificationSettings`. `email === false` or the new key `=== false`:
   the copy is done, not retried, as `sendNotification` treats an opt-out.
4. Takes the receipt's retailer and date (Q5).
5. Sends through `sendTemplated` with the receipt's link
   (`/receipts/<id>`), the same page the recipient reaches in the app.

The libraries never import the host's email code, and the host never writes
either library's tables; this is the existing port seam described in
`docs/architecture/RECEIPT_PIPELINE.md`.

### Content

Template tokens (all `text` except the link):

| Token | Source | Tier | In the recipient's app view? |
|---|---|---|---|
| `name` | recipient's own name | `public` | yes |
| `retailer` | receipt retailer | `internal` | yes, as their own receipt |
| `date` | receipt date | `internal` | yes |
| `actionLink` | `/receipts/<id>` | n/a | yes |

No token names the other recipient, the uploader to the reimbursee, the donor,
the approver or the finance holder who acted. No token carries the total,
finance's reason or a line's note (Q5); the email links to the receipt, where
the recipient reads them.

The uploader and reimbursee get the same template with different wording where
it matters: "your receipt" for the uploader, "a receipt for your
reimbursement" for the reimbursee.

### Preference (Q4-A)

`notificationSettings.emailPurchaseOutcomes`, absent meaning on. The
Communication page lists it with the others. That page saves only the keys it
loads, so the key has to be added there or a toggle of another preference
erases it.

## Build steps

Each is its own PR, in this order. No boundary PR is needed: no route is added,
no registry grant or token changes, and no existing field is re-tiered. The new
outbox columns are additive `@sensitivity` annotations, which the isolation
check exempts. Member email already leaves through `sendTemplated` without a
registered outbound surface, as the mailed-receipt acknowledgement does.

1. **Host mail function, templates and preference.** `lib/purchaseOutcomeMail.ts`
   with recipient resolution, contact and preference checks; the three templates
   in the email-template registry; the preference on the Communication page.
   Nothing calls it yet. Unit tests for recipient resolution (same person,
   different person, no reimbursee, no address, opted out).
2. **Receipt rejected.** `ReceiptOutcomeNotice` model and migration, the
   `OutcomeMail` port in the receipt contract, the write inside the finance
   reject transaction, the send after commit, the sweep, and the host binding.
   Adds the receipt-rejected rule to `docs/rules/expenses.md`.
3. **Expense outcomes.** `ExpenseOutcomeNotice` model and migration, the port in
   the expense contract, the write in each transition into a final state, the
   sweep on `qbo-posting`, and the host binding. Adds the expense rules to
   `docs/rules/expenses.md` and deletes this doc.

PRs 2 and 3 depend on 1 and not on each other.

## Tests

- **Unit (Jest, `checkin-app/`):** recipient resolution and preference handling
  in the host function; each template renders with its sample context and with
  no token naming another person.
- **Unit (Vitest, each package):** the notice is written by the transition and
  only by it; a second reject or a replayed transition writes no second row;
  the sweep sends owed copies, skips done ones, and stops after the attempt
  limit.
- **Integration (each package's database tier, run in CI):** the notice row
  commits or rolls back with the state change.
- **Flow (CI):** a finance rejection of a seeded receipt leaves one captured
  email at `/dev/sent-mail` for the uploader, and none on a second request.

## Rules to extract

At merge, these go into `docs/rules/expenses.md` under Receipts:

- When finance rejects a receipt, its uploader gets one email naming the
  retailer and date and linking to the receipt, and so does the person
  reimbursed when that is someone else. Neither email names the other person,
  and neither carries finance's reason or the total.
  [Decision — owner]
- When an expense closes with a rejected line, or a reimbursement is signed off
  and sent to the books, the receipt's uploader and the person reimbursed each
  get one email. A card charge's sign-off, a backfill, and an approver's
  exception send none.
  [Decision — owner]
- A person may turn these emails off; turning off all email also stops them.
  Only a live person with a verified sign-in email is emailed.
  [Decision — owner]
- An outcome email carries only what its recipient's own receipt pages show.
  [Decision — *Principle: least privilege*]

## Alternatives considered

- **One outbox in the receipt library, filled by a sweep that reads
  `purchaseOutcomes`.** The receipt library already reads the expense outcome
  for the app, so it could poll finalized receipts and email when one reaches a
  final outcome. It keeps the expense library unchanged, but the sweep would
  re-read every open receipt's outcome across libraries on each run, and the
  email would lag the event by up to a day. Writing the notice at the
  transition is cheaper and immediate.
- **One outbox in the host's database.** The libraries write through their own
  clients, so the host row could not commit in the same transaction as the
  state change, and a crash between the two would lose or duplicate an email.
- **Send from inside the transition, no outbox.** A provider error would either
  roll back finance's decision or lose the email; neither is acceptable.

## Appendix: provenance

- Issue #2662, filed from findings 1.18 and 3.30 of the receipt-flow conversion
  audit, split from #2467 on 2026-10-28 as the email part, low priority.
- The in-app part shipped as #2665 (boundary) and #2666: the rejected-receipt
  pill, "Got it", and the purchase outcome after "Receipt finalized".
- Finance's required rejection reason: #2592.
