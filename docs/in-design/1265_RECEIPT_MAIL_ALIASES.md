# Receipts: extra sending addresses for mail intake

## Problem

A member who forwards a receipt to the receipts mailbox from any address other
than the one they sign in with gets nothing back for it. Mail intake only knows
a person by their sign-in email, so a receipt sent from a work account, a second
personal account, or the store account an order confirmation went to lands in
finance's queue as mail from a stranger. Finance then has to work out who sent
it and assign it by hand, and the member, who did everything right from their
point of view, waits a day or more longer and never learns why.

## Objective

A person can list extra addresses they send receipts from. Once they have proved
they control an address, mail from it is treated exactly as mail from their
sign-in address: the same sender check, the same daily allowance, the same path
to their own "My receipts". An address nobody has proved, or one that could
belong to two people, never attributes mail to anyone.

## Executive summary

- **Submitters** get a short list on their account page: add an address, confirm
  it from a link emailed to that address while signed in, remove it at any time.
  Mail from a confirmed address becomes their receipt, as their sign-in address
  does today.
- **Household leads** add and remove addresses for a youth in a household they
  lead; a youth does not manage their own (§3).
- **Finance** can see a person's confirmed and pending addresses and remove one.
  It cannot add one or confirm one for anyone (§3).
- **Not changed:** the sender check (aligned DMARC on Google's own header), the
  upload limits, the OCR allowance, deferral, release, the conflict rule and the
  finance queue. An alias is the same person, so every one of those already keys
  on the person, not the address (§5).
- **Cost:** one new table on the checkin side, four routes, one account-page
  section, one email template. Nothing under the receipt library changes except
  one sentence of its port's doc comment (§4).

**Domain rules relied on.** `docs/rules/people-households.md`: an email address
identifies one person; email identity is case-insensitive; a youth cannot edit
their own profile; self-service add refuses an address in use without saying
whether anyone holds it; a merge moves email, sign-in identity and verification
as one unit. `docs/rules/expenses.md`: who may submit a receipt; nobody decides
on a receipt they or their household are conflicted on. `docs/rules/principles.md`:
self-scope and repair, fail closed, no existence oracle, identity is not
authorisation, accountability, least privilege.

**One rule this design narrows, and says so.** "An email address identifies one
person" stays true: an alias is unique across every person's sign-in address and
every other alias (§2). What changes is that a person may now be identified by
more than one address for one purpose, receipt mail. Sign-in, contact and every
other use of a person's email keep reading the sign-in address only.

---

## 1. Why the address must be proved

Aligned DMARC already proves that a message really came from the address in its
`From` header. It says nothing about whose address that is. Today that gap is
closed by the sign-in: a person's sign-in address was verified by Google when
they first linked it, so mapping that address to them is safe.

An alias has no such proof unless this design adds one. Without it, two things
go wrong:

- **A typo routes nothing, then routes the wrong person.** A member types
  `pat@example.net` for `pat@example.org`. Nothing arrives from it, until someone who owns that address
  emails the receipts mailbox, and their receipt becomes the member's.
- **A hostile alias steals attribution.** A member adds a colleague's address.
  Every receipt the colleague mails in becomes the member's, including any owed
  reimbursement the member then confirms in `submitter_review`.

So an alias counts only after its person has shown they can read mail at it and
are signed in as themselves at the same moment (§3). Both halves are needed:
the emailed link alone proves control of the mailbox, not who the mailbox owner
is in checkin.

---

## 2. Storage and uniqueness

**A checkin table, not the receipt library.** Who a person is belongs to
checkin; the library only asks, through the `ReceiptPeople` port it already has.
One new model beside `Person`:

| Field | Tier | Meaning |
|---|---|---|
| `id` | `internal` | |
| `personId` | `internal` | FK to `Person`, cascade on delete |
| `address` | `pii` | lowercased and trimmed, exactly as confirmed |
| `canonicalKey` | `pii` | `canonicalizeEmail(address)`; unique |
| `confirmedAt` | `internal` | null while pending |
| `tokenHash` | `secret` | SHA-256 of the emailed token; null once confirmed |
| `tokenExpiresAt` | `internal` | null once confirmed |
| `requestedById` | `internal` | the person who added it: the owner, or a lead for a youth |
| `createdAt` | `internal` | |

Named `PersonMailAlias`. Pending rows are real rows so that the list a person
sees does not depend on whether the address was free (§3, no existence oracle).

**Uniqueness, at write and at read.**

- **Write.** Adding or confirming an alias takes `pg_advisory_xact_lock` on the
  alias's canonical key and, inside that transaction, refuses an address whose
  canonical key matches any live person's sign-in address or any other row in
  this table, pending or confirmed. The unique index on `canonicalKey` backs the
  alias-to-alias half. Matching on the canonical key is stricter than the exact
  match intake uses, deliberately: `pat+receipts@example.com` cannot be one
  person's alias while `pat@example.com` signs in as someone else.
- **The receipt mailbox's own address is refused** as an alias. Mail the mailbox
  sends itself is not read, and allowing it would make that rule the only thing
  between a self-sent message and a receipt.
- **Read.** The sign-in address lives on `Person`, so a database constraint
  cannot span both tables, and the board can change a sign-in address later.
  The resolver therefore fails closed on ambiguity: an address that matches more
  than one person, by sign-in or by confirmed alias, resolves to nobody and the
  mail is held for finance (§4). Finance removes the stale alias to clear it.

**Merges.** A merge moves email, sign-in identity and verification as one unit,
so it moves aliases too: the merged-away record's confirmed aliases move to the
survivor; pending ones are deleted; any alias equal to the survivor's sign-in
address is deleted. The plan records the moved alias ids for the merge's
pre-image. A new FK to `Person` fails the merge repoint drift guard until this
disposition is declared, which is the intended signal.

---

## 3. Who may add, confirm, view and remove

| Action | Who | Scope |
|---|---|---|
| Add | the person themself, if adult; a lead of the household, for a youth in it | `their_own`; `led_households` and the row's person is a youth |
| Confirm | the person who added it, signed in, holding the emailed token | the token's row and `requestedById = caller` |
| View | the person; a lead, for a youth in a household they lead; `FINANCE` | `their_own:pii`; `led_households:pii`; `everyones:pii` |
| Remove | the person; a lead, for a youth; `FINANCE` | as view |

**Adding.** The person enters an address. The route always answers the same way:
the row is created pending, and the page says "If this address can be used, a
confirmation link is on its way to it. It expires in 72 hours." A confirmation
email is sent only when the address passes §2 at that moment; otherwise no email
goes and the pending row expires unconfirmed. This follows the self-service
add rule: the refusal says what will happen, never whether anyone holds the
address. Limits, stated as `ponytail:` constants: 3 pending rows per person and
10 confirmed aliases per person. An add over either limit is refused with that
reason, which reveals nothing about anyone else.

**Confirming.** The emailed link opens a checkin page that requires sign-in and
posts the token. The confirm succeeds only when the token hashes to a pending,
unexpired row, the signed-in caller is that row's `requestedById`, and §2 still
passes under the lock. Any failure gives one message ("This link can't be used.
Add the address again to get a new one.") and leaves the row pending. A confirmed
row clears its token. Tokens are 32 random bytes, single use, stored only as a
hash.

Requiring the requester to be signed in is what makes a forwarded link harmless:
the owner of a mistyped or hostile address can click it, and it does nothing,
because they are not signed in as the person who added it.

**Youth.** A youth cannot edit their own profile, so they cannot add an alias.
A lead of their household adds it and confirms it, signed in as the lead. That
proves the lead reads mail at the youth's address, which is the oversight the
household rules already give a lead. An unknown date of birth reads as adult
here, as it does for profile editing.

**Finance** views every person's aliases and removes any, which is the repair
path: an ambiguous address, a member who has lost access to an old account, a
departed member's address still attributing mail. Finance does not add or
confirm, because the proof in §1 has to come from the person. Adding a role to a
write gate is the change least privilege exists to catch, and nothing finance
does needs it.

**Removing** takes effect at once. Mail already turned into receipts stays
theirs. Deferred items from that address are held for finance on their next
retry, which mail intake already does for "a sender who is no longer a
submitter".

---

## 4. Resolving a sender

`submitterByEmail(address)` in `checkin-app/src/lib/receipt/configure.ts` widens
its lookup from "a live, sign-in-verified person whose email equals this
address" to "a live, sign-in-verified person whose email equals this address,
**or** who holds a confirmed `PersonMailAlias` with exactly this address". Both
are case-insensitive exact matches on the lowercased address; the canonical key
is used only for uniqueness, never for resolution, because only the exact
address was proved.

Everything after the lookup is unchanged: more than one match returns null; the
one match must still pass the `receipt-submitter` gate through the same claims
derivation; a denied person returns null. The function's callers do not change:

- **Mail intake** calls it only after DMARC alignment on the `From` address, so
  every alias goes through the same sender check as a sign-in address.
- **Deferred retry** re-resolves the stored sender address each run, so a removed
  alias stops resolving on the next run.
- **Finance's assign** resolves the address finance types; an alias now works
  there too, with finance's own vouching, as today.
- **Release** resolves the item's stored sender address.

The port's doc comment in `packages/receipt/src/contract.ts` says "whose sign-in
email is exactly this address"; it becomes "whose sign-in email or confirmed
receipt alias is exactly this address". That one-line comment edit waits for the
package rename freeze to lift; the port's signature does not change.

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

One inefficiency, not a defect: the deferred retry remembers which **addresses**
hit the daily limit this run. A person over their limit with deferred items
under two addresses costs one extra refused retry per run; a refused retry spends
no cap and no reading. Keying that set on the person id is a one-line change in
the library after the freeze, if it ever matters.

---

## 6. Audit trail

Every add, confirm, failed confirm, and removal writes an `AuditLog` row:
actor, `tableName = PersonMailAlias`, the alias id, the person id as the
secondary entity, and the action. The payload carries no address, so the audit
trail stays `internal`; the alias id leads back to the row while it exists. A
removed alias's row is deleted; its audit rows keep the id, the person and who
removed it, which answers "who stopped this address counting, and when".
Finance's views of another person's aliases write a view row, as the mail queue
does.

Which address attributed a mailed receipt is already on the mail item and the
receipt's own audit trail (§4).

---

## 7. Sensitivity

The address and its canonical key are `pii`, like `Person.email`. The token hash
is `secret` and never leaves the server. Every other column is `internal`. No
receipt route returns aliases; only the four alias routes do.

---

## 8. Boundary split and phasing

Boundary isolation (`AGENTS.md`) puts the registry entries in their own PR,
first, based on `main`:

| PR | Contents |
|---|---|
| **A1** boundary | A `PersonMailAlias` entry in `scopeBindings.ts` (`their_own` and `led_households` on `personId`) and four registry entries: `GET /api/people/[id]/mail-aliases`, `POST /api/people/[id]/mail-aliases`, `DELETE /api/people/[id]/mail-aliases/[aliasId]`, `POST /api/mail-aliases/confirm`. Security tests may accompany. No app code. Maintainers, alone. |
| **A2** feature | The routes, the resolver change, the merge disposition, the account-page section, the confirmation email and page, and tests. Based on `main` after A1 merges, never stacked on A1's branch. |

**Where the model goes is not settled** (ALIAS-6). The schema drift check fails
any PR whose `schema.prisma` has no matching migration, so the model and its
migration travel together. The scope binding and the registry's `returns` name
the model through the generated classifications, so A1 may not compile without
it. Then A1 carries the model, its annotations, the regenerated classifications
and the migration as well; schema annotations may accompany a boundary PR, and
the migration is the schema's.

**Migration** (A1 or A2, per ALIAS-6): additive only, one `CREATE TABLE` for `PersonMailAlias`, its
unique index on `canonicalKey`, an index on `personId`, and the FK to `Person`,
inside `BEGIN; … COMMIT;`. No existing column is touched and no backfill is
needed, so old code serving through the deploy drain never sees a difference.

**Tests** (A2, not run here): a typo'd alias never confirms; a link clicked by
someone not signed in as the requester does nothing; an alias equal to another
person's sign-in address or alias is never emailed, and the add's response is
identical to a free address's; ambiguity resolves to null; mail from a confirmed
alias with DMARC alignment becomes the person's receipt, and without alignment is
held; two addresses share one daily allowance; a removed alias's deferred items
are held on the next run; a lead adds and confirms for a youth and cannot for an
adult; finance removes but cannot add; a merge moves confirmed aliases.

---

## 9. Open questions for the owner

- **ALIAS-1. Should the board, or a sysadmin, also be able to view and remove
  aliases?** I propose finance only, since aliases exist only for receipt mail.
  Which superuser repairs what is the wider question #1551 holds.
- **ALIAS-2. Should a youth in the submitter audience manage their own
  aliases?** I propose no, matching "a youth cannot edit their own profile", with
  the lead confirming. The alternative lets the youth confirm their own,
  signed in as themself.
- **ALIAS-3. Should the board's sign-in-address edit refuse an address that is
  someone's confirmed alias?** I propose not changing that path: the resolver's
  ambiguity rule already fails closed, and finance removes the alias. Refusing
  there would need a new check in a people-side path this design otherwise leaves
  alone.
- **ALIAS-4. Should the person be told when an alias is added or removed by
  someone else** (a lead, or finance), by email to their sign-in address? I
  propose yes for a finance removal, since it changes where their mail goes, and
  no for a lead acting for a youth.
- **ALIAS-5. Are 72 hours, 3 pending and 10 confirmed the right limits?** They
  are safety constants, not organisation settings; any of them can move.
- **ALIAS-6. Does the new model and its migration ride in the boundary PR?**
  Only if A1 cannot compile without them (§8). I have not checked whether the
  registry's `returns` and the scope-binding table type-check against a model
  that does not exist yet; the builder of A1 confirms before splitting.

---

## 10. Distillation at merge

Into `docs/rules/people-households.md`: a person may hold extra addresses for
receipt mail only, each unique across every person's sign-in address and alias,
and none counts until the person who added it confirms it from that address
while signed in. Into `docs/rules/expenses.md`: mail from a confirmed alias is
the person's own, on the same allowance. The rest is mechanism and is deleted.

---

*Design for receipt mail aliases, part of #1265 (phase G, §2a); referenced
without a closing keyword.*
