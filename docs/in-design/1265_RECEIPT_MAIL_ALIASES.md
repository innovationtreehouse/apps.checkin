# Receipts: extra sending addresses for mail intake

## Problem

Mail intake knows a person only by the email they sign in with. A member who
forwards a receipt from any other address, such as a work account, a second
personal account, or the store account an order confirmation went to, lands in
finance's queue as mail from a stranger. Finance works out who sent it and
assigns it by hand, and does the same again the next time that member mails
from the same address, because nothing remembers the answer.

## Objective

Finance or the Board can record, once, that an address belongs to a person.
After that, mail from it is treated exactly as mail from that person's sign-in
address: the same sender check, the same daily allowance, the same path to
their own "My receipts". An address that could belong to two people never
attributes mail to anyone.

## Executive summary

- **Finance and the Board** get a back-office screen listing every alias, with
  add and remove. It is a finance tool; nothing about it is shown to members.
- **Members** see nothing new and do nothing new. Mail from a recorded alias
  simply stops waiting in the finance queue.
- **Not changed:** the sender check (aligned DMARC on Google's own header), the
  upload limits, the OCR allowance, deferral, release, the conflict rule and the
  finance queue. An alias is the same person, so every one of those already keys
  on the person, not the address (§5).
- **Changed elsewhere:** when anyone changes a person's sign-in email to an
  address that is an alias, the alias is removed in the same change (§2).
- **A new alias counts only after finance approves it.** Its first mail lands
  in the finance queue as today; finance assigns it and approves the alias, and
  from then on its mail is automatic (§3).
- **Cost:** one new table on the checkin side, four routes, one
  back-office page. Nothing under the receipt library changes now (§4).

**Domain rules relied on.** `docs/rules/people-households.md`: an email address
identifies one person; email identity is case-insensitive; nobody grants a role
or flag for themself or their own household; a merge moves email, sign-in
identity and verification as one unit. `docs/rules/expenses.md`: who may submit
a receipt; the Board may view and edit receipt data; nobody decides on a receipt
they or their household are conflicted on. `docs/rules/principles.md`:
self-scope and repair, fail closed, identity is not authorisation,
accountability, least privilege.

**One rule this design narrows, and says so.** "An email address identifies one
person" stays true: an alias is unique across every person's sign-in address and
every other alias (§2). What changes is that a person may now be identified by
more than one address for one purpose, receipt mail. Sign-in, contact and every
other use of a person's email keep reading the sign-in address only.

---

## 1. Who manages aliases

| Action | Who |
|---|---|
| List all aliases, with each one's person | `FINANCE` or `BOARD` |
| Add an alias to a person | `FINANCE` or `BOARD`, never for themself or their own household |
| Remove an alias | `FINANCE` or `BOARD` |

The gate is the existing `finance-or-board` authorize token, with an
`everyones:pii` view; there is no per-row scope, because no one else ever reads
these rows. The person an alias belongs to is not shown it and is not told when
it is added or removed: aliases are a back-office finance function, not a
member-facing setting.

**The conflict rule applies to adding.** Recording an alias decides whose
receipts an address's mail becomes, including any reimbursement claimed on
them. So nobody adds an alias for themself or anyone in their own household;
the attempt is refused with a `decision_refused` audit row, as the mail queue
already refuses assigning a receipt to oneself. Removing is allowed for anyone
on the gate, since removal only sends that address's mail back to the queue.

**Removal takes effect at once.** Mail already turned into receipts stays with
its person. Deferred items from that address are held for finance on their next
retry, which mail intake already does for "a sender who is no longer a
submitter".

---

## 2. Storage and uniqueness

**A checkin table, not the receipt library.** Who a person is belongs to
checkin; the library only asks, through the `ReceiptPeople` port it already has.
One new model beside `Person`, named `PersonMailAlias`:

| Field | Tier | Meaning |
|---|---|---|
| `id` | `internal` | |
| `personId` | `internal` | FK to `Person`, cascade on delete |
| `address` | `pii` | lowercased and trimmed, exactly as entered |
| `canonicalKey` | `pii` | `canonicalizeEmail(address)`; unique |
| `addedById` | `internal` | the finance or Board person who added it |
| `createdAt` | `internal` | |
| `approvedAt` | `internal` | null until approved; only an approved alias counts (§3) |
| `approvedById` | `internal` | who approved it |

**Uniqueness when an alias is added.** The add takes `pg_advisory_xact_lock` on
the canonical key and, inside that transaction, refuses an address whose
canonical key matches any live person's sign-in address or any other alias. The
unique index on `canonicalKey` backs the alias-to-alias half. Matching on the
canonical key is stricter than the exact match intake uses, deliberately:
`pat+receipts@example.com` cannot be one person's alias while `pat@example.com`
signs in as someone else. The refusal names the reason ("already a sign-in
address" or "already an alias"); finance and the Board are entitled to know who
holds an address, and the screen already lists every alias.

The receipt mailbox's own address is refused as an alias. Mail the mailbox sends
itself is not read, and allowing it would leave that rule as the only thing
between a self-sent message and a receipt.

**A sign-in email change removes a matching alias.** When any path sets a
person's sign-in email to an address whose canonical key is an alias, of that
person or anyone else, the change goes ahead and the alias is deleted in the
same transaction, with an audit row naming the alias id, its person and the
change that removed it. That covers the Board's sign-in-email edit, the
household card's email edit while it is still allowed, and any other write of
`Person.email`. One helper does the delete, and every such write calls it; a
test enumerates the writes so a new one cannot skip it.

**The resolver still fails closed on ambiguity**, because a database constraint
cannot span the two tables and a path could be added later that forgets the
helper. An address that matches more than one person, by sign-in or by alias,
resolves to nobody, and the mail is held for finance (§4).

**Merges.** A merge moves email, sign-in identity and verification as one unit,
so it moves aliases too: the merged-away record's aliases move to the survivor,
and any alias equal to the survivor's sign-in address is deleted. The plan
records the moved alias ids for the merge's pre-image. A new FK to `Person`
fails the merge repoint drift guard until this disposition is declared, which is
the intended signal.

---

## 3. Approval: the first mail is held once

**A new alias does not count until finance or the Board approves it.** Until
then the resolver ignores it, so mail from the address is held in the finance
queue exactly as an unknown sender's is. Finance assigns that first item by
hand, as today, having seen what the receipt is and whose it looks like, then
approves the alias on the alias screen. From the next mail on, the address is
automatic. Approval writes an audit row and is refused under the same conflict
rule as adding: nobody approves an alias of their own or their household's.

The two clicks are separate for now, because the mail queue is in the frozen
receipt library. After the freeze, assigning a held item from an unapproved
alias to that alias's person can approve the alias in the same action (§8).

**Why a check is needed at all.** Once an alias counts, every mail from that
address is read automatically as that person's receipt: it spends their daily
upload limit and OCR allowance, appears in their "My receipts", and waits in
their review step, where they could claim it as owed to them. If finance types
the address wrong, or records an address that is really another member's or a
stranger's, the owner of that address can send mail that is processed as this
person without anyone looking at it. Today the same mail waits in the finance
queue until someone assigns it. The sender check does not help: DMARC proves the
mail came from the address, not that the address belongs to the person finance
named. A typo in a long address, or a household's shared account recorded
against one adult, is the realistic failure.

**Alternatives considered.**

| | Finance's entry is trusted | Confirmation link emailed to the alias | First mail held once (chosen) |
|---|---|---|---|
| Catches a typo or wrong address | No; found only when the person notices strange receipts | Partly: proves someone reads that mailbox, not that it is this person | Yes: a person sees the first receipt before anything is automatic |
| Member-facing step | None | An email the member did not ask for, from a feature they never see | None |
| Build | Nothing extra | Token table, email template, confirm page and route, expiry | Two columns, one approve route, a "waiting for first mail" badge |
| Cost to finance | None | None, unless the link expires unread | One extra click per alias, on mail it would have assigned by hand anyway |

The held first mail keeps the tool back-office, and its check is a person
looking at a real receipt from the address, which is the evidence that settles
whose address it is.

---

## 4. Resolving a sender

`submitterByEmail(address)` in `checkin-app/src/lib/receipt/configure.ts` widens
its lookup from "a live, sign-in-verified person whose email equals this
address" to "a live, sign-in-verified person whose email equals this address,
**or** who holds an approved alias with exactly this address". Both are case-insensitive exact matches on the lowercased address; the
canonical key is used only for uniqueness, never for resolution.

Everything after the lookup is unchanged: more than one match returns null; the
one match must still pass the `receipt-submitter` gate through the same claims
derivation; a denied person returns null. The function's callers do not change:

- **Mail intake** calls it only after DMARC alignment on the `From` address, so
  every alias goes through the same sender check as a sign-in address.
- **Deferred retry** re-resolves the stored sender address each run, so a removed
  alias stops resolving on the next run.
- **Finance's assign** resolves the address finance types; an alias works there
  too.
- **Release** resolves the item's stored sender address.

`ReceiptMailItem.senderAddress` already records the exact address each mailed
receipt came from, so which alias attributed a receipt needs no new column.

---

## 5. Deferral, limits and release

An alias resolves to the same `ReceiptPrincipal`, with the same `id`. Every
limit keys on that id, not on the address:

- the daily upload limit (`uploadsPerPersonPerDay`) and the OCR allowance
  (`ocrCallsPerPersonPerDay`, under an advisory lock on the person id) are one
  allowance across all of a person's addresses. Mailing from a second address
  buys no extra receipts;
- deferral stores the item with the address it came from and retries it as that
  person;
- finance's release and the conflict rule compare person ids and households, so
  an alias cannot be used to release a receipt to oneself.

---

## 6. Audit trail

Every add, removal (including one caused by a sign-in email change or a merge),
refused add and approval writes an `AuditLog` row: actor,
`tableName = PersonMailAlias`, the alias id, the person id as the secondary
entity, and the action. The payload carries no address, so the audit trail stays
`internal`; the alias id leads back to the row while it exists, and once it is
removed the audit rows still say whose it was, who added it, and who or what
removed it. Every view of the alias screen writes a view row, as the mail queue
does.

Which address attributed a mailed receipt is already on the mail item and the
receipt's own audit trail (§4).

---

## 7. Sensitivity

The address and its canonical key are `pii`, like `Person.email`. Every other
column is `internal`. Only the alias routes return aliases, and only to
`FINANCE` or `BOARD`; no receipt or person route returns them.

---

## 8. PR split and phasing

Three PRs, in this order, each based on `main` after the one before it merges.
None stacks on another's branch.

| PR | Contents |
|---|---|
| **A1** schema | The `PersonMailAlias` model with its `@sensitivity` annotations, its migration, and the regenerated classifications. Annotating a new model's fields is not a re-tier, so this is not a boundary PR. The schema drift check needs the model and migration together, and this PR carries both. |
| **A2** boundary | Registry entries, all `finance-or-board` with an `everyones:pii` view: `GET /api/finance/mail-aliases`, `POST /api/finance/mail-aliases`, `DELETE /api/finance/mail-aliases/[id]`, `POST /api/finance/mail-aliases/[id]/approve`. No scope binding is needed. Nothing else. Maintainers, alone. |
| **A3** feature | The routes, the service, the resolver change, the sign-in-email helper and its callers, the merge disposition, the back-office page and its nav entry, and tests. |

**Migration** (A1): additive only, one `CREATE TABLE` for `PersonMailAlias`, its
unique index on `canonicalKey`, an index on `personId`, and the FK to `Person`,
inside `BEGIN; … COMMIT;`. No existing column is touched and no backfill is
needed, so old code serving through the deploy drain never sees a difference.

**Tests** (A3, not run here): mail from an alias with DMARC alignment becomes
the person's receipt, and without alignment is held; an alias equal to another
person's sign-in address or alias is refused; ambiguity resolves to null; two
addresses share one daily allowance; a removed alias's deferred items are held
on the next run; a sign-in email change to an alias's address removes the alias
with an audit row, on every write path; finance and the Board add and remove,
nobody else does, and nobody adds for their own household; a merge moves
aliases; an unapproved alias's mail is held, and approval makes the
next mail a receipt.

**After the package rename freeze lifts**, small library edits, none needed for
A1 to A3 to work:

- the `ReceiptPeople.submitterByEmail` doc comment in
  `packages/receipt/src/contract.ts` says "whose sign-in email is exactly this
  address"; it becomes "whose sign-in email or alias is exactly this address";
- the deferred retry remembers which addresses hit the daily limit this run,
  so a person over their limit with deferred items under two addresses costs
  one extra refused retry per run. A refused retry spends no cap and no reading,
  so this is waste, not a defect; keying the set on the person id fixes it;
- assigning a held item from an unapproved alias to that
  alias's person can approve the alias in the same action.

---

## 9. Owner questions

All resolved; IDs are kept, and each decision is in the design above.

- **ALIAS-1.** Resolved: finance or the Board add and remove aliases (§1).
- **ALIAS-2.** Resolved: a youth does not manage their own aliases; nobody
  outside finance and the Board does (§1).
- **ALIAS-3.** Resolved: a sign-in email change to an alias's address goes
  ahead and removes the alias in the same transaction, with an audit row (§2).
- **ALIAS-4.** Resolved: no notifications; aliases are not member-facing (§1).
- **ALIAS-5.** Resolved by the model change: the expiry and per-person limits
  existed to stop self-service abuse, and with no self-service they are dropped.
- **ALIAS-7.** Resolved: a new alias counts only after finance or the Board
  approves it, on the evidence of its first mail, held once (§3).

---

## 10. Distillation at merge

Into `docs/rules/people-households.md`: a person may be identified by extra
addresses for receipt mail only, recorded by finance or the Board and never for
their own household, each unique across every person's sign-in address and
alias; a sign-in email change to an alias's address removes the alias. Into
`docs/rules/expenses.md`: mail from a person's alias is their own, on the same
allowance, and an alias counts only after finance approves its first
mail. The rest is mechanism and is deleted.

---

*Design for receipt mail aliases, part of #1265 (phase G, §2a); referenced
without a closing keyword.*
