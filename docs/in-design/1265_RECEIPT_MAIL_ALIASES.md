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
  upload limits, the OCR allowance, deferral, release and the conflict rule. An
  alias is the same person, so every one of those already keys
  on the person, not the address (§5).
- **Changed elsewhere:** when anyone changes a person's sign-in email to an
  address that is an alias, the alias is removed in the same change (§2).
- **A new alias counts only after finance approves it.** Its first mail lands
  in the finance queue as today; finance assigns it and approves the alias, and
  from then on its mail is automatic (§3).
- **Not covered:** an address whose domain publishes no DMARC record never
  resolves, so its mail stays in the finance queue (§4).
- **Cost:** one new table on the checkin side, four routes, one back-office
  page, and one receipt-library change after the package rename freeze: a stored
  DMARC verdict on each mail item, which approval needs (§3, §8).

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
the attempt is refused with an audit row, as the mail queue already refuses
assigning a receipt to oneself and writes `mail_assign_refused`. Removing is allowed for anyone
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
| `address` | `pii` | lowercased and trimmed, exactly as entered; unique |
| `canonicalKey` | `pii` | `canonicalizeEmail(address)`; indexed, not unique |
| `addedById` | `internal` | the finance or Board person who added it; a plain id, not a relation |
| `createdAt` | `internal` | |
| `approvedAt` | `internal` | null until approved; only an approved alias counts (§3) |
| `approvedById` | `internal` | who approved it; a plain id, not a relation |

`addedById` and `approvedById` record an actor, as `AuditLog.actorId` does, so
they are plain integers rather than `Person` relations. A merged-away actor's
record is kept, so the id still names who acted, and the merge has nothing to
move.

**Uniqueness when an alias is added.** The add takes `pg_advisory_xact_lock` on
the canonical key and, inside that transaction, refuses an address whose
canonical key matches **another** person's sign-in address or alias. Matching on
the canonical key is stricter than the exact match intake uses, deliberately:
`pat+receipts@example.com` cannot be one person's alias while `pat@example.com`
signs in as someone else.

The same person's variants are allowed. A member who signs in as
`patsmith@gmail.com` and mails from `pat.smith@gmail.com` or
`patsmith+r@gmail.com` can have each recorded as an alias: resolution is by
exact address (§4), so each variant that is actually used needs its own row,
and none of them collides with anyone else. The unique index is on `address`,
which stops the same exact address being recorded twice; the cross-person
canonical check runs under the lock, since no index can express "unique except
within one person". Adding the person's own exact sign-in address is refused as
pointless. The refusal names the reason ("already a sign-in
address" or "already an alias"); finance and the Board are entitled to know who
holds an address, and the screen already lists every alias.

The receipt mailbox's own address is refused as an alias. The Gmail reader skips
only messages in Sent (`-in:sent`); mail from outside that claims the mailbox's
address is still read, so this refusal is what keeps such mail from ever
resolving to a person.

**A sign-in email change removes a matching alias.** When any path sets a
person's sign-in email to an address whose canonical key is an alias, of that
person or anyone else, the change goes ahead and the alias is deleted in the
same transaction, with an audit row naming the alias id, its person and the
change that removed it. That covers the Board's sign-in-email edit, the
household card's email edit while it is still allowed, and any other write of
`Person.email`. One helper does the delete, and every such write calls it; a
test enumerates the writes so a new one cannot skip it. The helper takes the
same `pg_advisory_xact_lock` on the new address's canonical key as an alias add,
so an add and an email change running at once are serialised: whichever commits
second sees the other's row.

**The resolver still fails closed on ambiguity**, because a database constraint
cannot span the two tables and a path could be added later that forgets the
helper. An address that matches more than one person, by sign-in or by alias,
resolves to nobody, and the mail is held for finance (§4).

**Merges.** A merge moves email, sign-in identity and verification as one unit,
so it moves aliases too: the merged-away record's aliases move to the survivor,
and any alias equal to the survivor's sign-in address is deleted. The plan
records the moved alias ids for the merge's pre-image. A new FK to `Person`
fails the merge repoint drift guard until its disposition is declared, so the
`PersonMailAlias.personId` entry (deduped, for the deletion above) and the merge
code that applies it ship in A1 with the model (§8). `personId` is the only
`Person` relation on the model.

---

## 3. Approval: the first mail is held once

**A new alias does not count until finance or the Board approves it.** Until
then the resolver ignores it, so mail from the address is held in the finance
queue exactly as an unknown sender's is. Finance assigns that first item by
hand, as today, having seen what the receipt is and whose it looks like, then
approves the alias on the alias screen. From the next mail on, the address is
automatic.

**Approval has preconditions, checked by the approve route**, so it cannot
collapse into "finance's entry is trusted":

- a mail item from exactly the alias's address has been assigned to the
  alias's person;
- that item's stored DMARC verdict is a pass. A held item can carry a forged
  `From` (an unauthenticated message claiming the alias's address); its contents
  say nothing about who controls the address, so it cannot approve anything;
- the approver is not the alias's person or in their household.

Approval writes an audit row naming the mail item it relied on.

**The DMARC verdict is not stored today.** Mail intake decides alignment and
then keeps only whether a sender resolved, so a held item from an unknown but
authenticated sender looks the same as a forged one. The receipt library gains a
verdict column on each mail item (`pass`, `fail` or `none`), shows it in the
mail queue, and answers "has an item from this address, with a passing verdict,
been assigned to this person" for the approve route. That is a library change,
so it waits for the package rename freeze to lift (§8). Until it ships, aliases
can be added but none can be approved, and so none counts. That is the safe
direction: mail keeps reaching finance as it does today.

After the freeze, assigning a passing held item from an unapproved alias to that
alias's person can approve the alias in the same action.

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
| Catches a typo or wrong address | No; found only when the person notices strange receipts | Partly: proves someone reads that mailbox, not that it is this person | Usually: a person sees an authenticated receipt from the address before anything is automatic |
| Member-facing step | None | An email the member did not ask for, from a feature they never see | None |
| Build | Nothing extra | Token table, email template, confirm page and route, expiry | Two columns, one approve route, a "waiting for first mail" badge, the stored verdict |
| Cost to finance | None | None, unless the link expires unread | One extra click per alias, on mail it would have assigned by hand anyway |

The held first mail keeps the tool back-office. Its check is a person looking
at an authenticated receipt from the address and judging whose it is. That is
good evidence, not proof: a stranger's genuine receipt could still look like
the member's, and the audit row records who judged it.

---

## 4. Resolving a sender

`submitterByEmail(address)` in `checkin-app/src/lib/receipt/configure.ts` widens
its lookup from "a live, sign-in-verified person whose email equals this
address" to "a live, sign-in-verified person whose email equals this address,
**or** who holds an approved alias with exactly this address". Both are
case-insensitive exact matches on the lowercased address; the canonical key is
used only for uniqueness, never for resolution.

**The claims come from the person, not the incoming address.** Today the
function builds the session-shaped claims with `email` set to the person's
sign-in email and `hd` set to the domain of the address it was asked about. For
a sign-in match the two domains are the same. For an alias match they are not:
a staff member whose only standing is a Treehouse account, mailing from a
personal Gmail alias, would get `hd` = the Gmail domain, fail the
Treehouse-account test in `canSubmitReceipts`, and resolve to nobody. So `hd`
is taken from the person's sign-in email in both cases. The incoming address is
used only to find the person.

Everything after the lookup is unchanged: more than one match returns null; the
one match must still pass the `receipt-submitter` gate through the same claims
derivation; a denied person returns null.

**A domain without DMARC never resolves.** Mail intake calls the resolver only
after aligned DMARC on Google's own header. An alias on a domain that publishes
no DMARC record gets `dmarc=none`, so its mail is held every time, as an
unknown sender's is. Such an alias also cannot be approved, because approval
needs a passing verdict (§3), so finance learns it at the approval step rather
than from mail that silently never arrives. This is the sender check doing its
job, not a gap to close here.

The function's callers do not change:

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
refused add, approval and refused approval writes an `AuditLog` row: actor,
`tableName = PersonMailAlias`, the alias id, the person id as the secondary
entity, the action, and for an approval the mail item it relied on. New
`AuditAction` values for these ship with the model in A1. The payload carries
no address, so the audit trail stays `internal`; the alias id leads back to the row while it exists, and once it is
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

Three checkin PRs, in this order, each based on `main` after the one before it
merges, plus one receipt-library PR once the package rename freeze lifts. None
stacks on another's branch.

| PR | Contents |
|---|---|
| **A1** schema | The `PersonMailAlias` model with its `@sensitivity` annotations, its migration, the new `AuditAction` values, and the regenerated classifications. The merge disposition for `PersonMailAlias.personId` in the repoint drift guard's map, and the merge code that applies it, so A1 merges green. Annotating a new model's fields is not a re-tier, so this is not a boundary PR. The schema drift check needs the model and migration together, and this PR carries both. |
| **A2** boundary | Registry entries, all `finance-or-board` with an `everyones:pii` view: `GET /api/finance/mail-aliases`, `POST /api/finance/mail-aliases`, `DELETE /api/finance/mail-aliases/[id]`, `POST /api/finance/mail-aliases/[id]/approve`. No scope binding is needed. Nothing else. Maintainers, alone. |
| **A3** feature | The routes, the service, the resolver change (including `hd` from the sign-in email) and its doc comment in `configure.ts`, the sign-in-email helper and its callers, the back-office page and its nav entry, and tests. The approve route refuses every request until L1 is on `main`. |
| **L1** library, after the freeze | The DMARC verdict column on `ReceiptMailItem` and its migration; the verdict shown in the mail queue; the "assigned, passing item from this address to this person" query the approve route calls. Doc comments that say "sign-in email": `ReceiptPeople.submitterByEmail` in `contract.ts` and `assign` in `mailQueueService.ts`. Optional: key the deferred retry's "hit the daily limit this run" set on the person id, not the address; today a person over their limit with deferred items under two addresses costs one extra refused retry per run, which spends no cap and no reading. Optional: assigning a passing held item from an unapproved alias to its person approves the alias in the same action. |

**Migration** (A1): additive only, inside `BEGIN; … COMMIT;`: one `CREATE TABLE`
for `PersonMailAlias`, a unique index on `address`, an index on `canonicalKey`,
an index on `personId`, the FK to `Person`, and `ALTER TYPE "AuditAction" ADD
VALUE IF NOT EXISTS` for each new action. Postgres 12+ allows `ADD VALUE` inside
the transaction only because nothing in this migration uses the new values; the
pattern is `20261013120000_program_surplus_payment_kinds`. No
existing column is touched and no backfill is needed, so old code serving
through the deploy drain never sees a difference.

**Tests** (A3, not run here): mail from an approved alias with DMARC alignment
becomes the person's receipt, and without alignment is held; a Treehouse-account
staff member resolves from a personal alias; an alias whose canonical key
matches another person's sign-in address or alias is refused, and the same
person's dot and plus variants are allowed; ambiguity resolves to null; two
addresses share one daily allowance; a removed alias's deferred items are held
on the next run; a sign-in email change to an alias's address removes the alias
with an audit row, on every write path, under the shared lock; finance and the
Board add and remove, nobody else does, and nobody adds or approves for their
own household; a merge moves aliases; an unapproved alias's mail is held;
approval is refused with no assigned item from the address, with an item
assigned to someone else, or with a failing or missing verdict, and with all
three met makes the next mail a receipt.

---

## 9. Owner questions

All resolved; IDs are kept, and each decision is in the design above.

- **ALIAS-1.** Resolved (owner, 2026-10-17): finance or the Board add and
  remove aliases (§1).
- **ALIAS-2.** Resolved (owner, 2026-10-17): a youth does not manage their own
  aliases; nobody outside finance and the Board does (§1).
- **ALIAS-3.** Resolved (owner, 2026-10-17): a sign-in email change to an
  alias's address goes ahead and removes the alias in the same transaction,
  with an audit row (§2).
- **ALIAS-4.** Resolved (owner, 2026-10-17): no notifications; aliases are not
  member-facing (§1).
- **ALIAS-5.** Dropped (coordinator): the expiry and per-person limits existed
  to stop self-service abuse, and with no self-service they no longer apply.
- **ALIAS-6.** Resolved (coordinator): the model and its migration ship in
  their own PR ahead of the registry entries (§8).
- **ALIAS-7.** Resolved (owner, 2026-10-17): a new alias counts only after
  finance or the Board approves it, on the evidence of its first authenticated
  mail, held once (§3).

---

## 10. Distillation at merge

Into `docs/rules/people-households.md`: a person may be identified by extra
addresses for receipt mail only, recorded by finance or the Board and never for
their own household, each unique across every person's sign-in address and
alias; a sign-in email change to an alias's address removes the alias. Into
`docs/rules/expenses.md`: mail from a person's alias is their own, on the same
allowance, and an alias counts only after finance or the Board approves it
from an authenticated first mail assigned to that person. The rest is mechanism and is deleted.

---

*Design for receipt mail aliases, part of #1265 (phase G, §2a); referenced
without a closing keyword.*
