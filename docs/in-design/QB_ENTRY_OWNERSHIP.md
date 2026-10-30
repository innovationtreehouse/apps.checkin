# QuickBooks: one owner per kind of entry

Design for the cross-lane fix named in `QB_CLOSED_BOOKS.md` § Related fixes
(#2242, #2299).

## Problem

Three parts of the app book money into QuickBooks: expenses, Shopify income and
bulk donations. A fourth, in-kind gifts, will follow. Each either creates a
QuickBooks entry for one of its records or matches the record to an entry
finance booked by hand.

Each part makes sure it never gives one entry to two of its own records. Two
parts can still give one entry to two records between them. A Shopify payout
and a Benevity disbursement with the same net amount land in the same bank
account in the same week, and finance books one deposit by hand. Income's run
and donation's run start at the same moment, each sees the deposit free, and
each links it. The books count the money twice, and nobody is told.

The two parts cannot settle this between themselves. Each keeps its own
database, so no transaction covers both, and none of the app's databases is a
master that could hold a shared list for everyone: checkin's own is due to
become a package like the rest.

## Objective

One QuickBooks entry belongs to at most one app record, everywhere, at every
moment (principle *Apply once*), without a shared database or a master.

## Executive summary

- **The rule.** Each kind of QuickBooks entry has exactly one package that books
  and matches it. "One entry, one record" is then a unique constraint inside
  that package's own database, which every package already knows how to keep.
- **Deposits (money in) → income.** Bulk donation stops talking to QuickBooks.
  It hands each Benevity disbursement to income as an expected deposit and reads
  back the result. Income already reconciles Shopify payouts against deposits;
  it now does the same for every source of incoming money.
- **Purchases and Bills (money out) → expense.** No change today: only expense
  books them. When in-kind needs one, expense takes the request through an
  intake port and books it with its existing machinery.
- **Journal entries → in-kind,** which books each gift as one. A second user
  would get one owner by the same rule.
- **One books map.** Which QuickBooks account and Class a line books to is
  answered in one place, beside the budget buckets, through one port. No lane
  keeps its own copy, so two lanes cannot disagree about the bank account.
- **For finance.** Every "which deposit is this money?" decision moves to one
  queue, income's, instead of two. Donation's QuickBooks queue retires.
- **What goes away.** Donation's copy of the posting machinery (claim, call and
  settle, the key lookup, the closed-books gate, drift, the orphan sweep, the
  finance queue and its exclusions) and the cross-lane list the host binds into
  income and donation today. Nothing replaces them; income's copies serve both.
- **Cost.** Income's reconciliation rows learn a second source, donation's
  QuickBooks holdings move once into income's database, and donation's three
  QuickBooks routes retire.

## Rules

No new principle: *Apply once* already says one entry in the books belongs to
one record, and which part of the app keeps that true is implementation.

One bullet joins `docs/rules/revenue.md` § Donations, after the finished-batch
bullet, because nothing today says a batch's money must reach the books:

> - Every finished giving-platform batch must match one deposit in the books.
>   Finance settles any the app can't match and records why. [Decision]

## Why this and not a shared claim list

A list of claimed entries shared by every part was designed first and
model-checked. It works, but only as a reserve-then-confirm protocol across
databases: two timing guards, a daily sweep in both directions, and a host that
holds the list. It needs a master database to keep the list in, and there is
none to rely on. The clash it guards against exists only because two databases
each hold half of the deposits. Put the deposits in one database and the clash
becomes the unique constraint income already has on its deposit link, inside
the claim, call and settle rules the closed-books work already checked for each
lane.

QuickBooks itself could referee instead: a part writes its key into the entry's
memo before linking, and QuickBooks rejects the second of two edits made against
the same version. That edits finance's own entries, and closed books refuse the
edit, so it is not proposed.

## Design

### Which entry kinds clash

QuickBooks numbers each entry kind separately, so only parts booking the same
kind can clash.

| Kind | Booked or matched by today | Owner |
|---|---|---|
| Deposit | income (Shopify payouts), donation (Benevity disbursements) | income |
| Purchase, Bill | expense (expenses and single lines) | expense |
| Journal entry | in-kind (one per gift) | in-kind, while it is the only user |

Expense already keeps one entry per record across its expenses and lines with
its own claim table, unique on organisation, entry kind and id. It needs nothing
new for itself.

### The books map

Three lookups turn an app line into a QuickBooks line. Today one is shared and
two are not:

| Lookup | Today |
|---|---|
| Budget bucket → Class | Shared: stored once on the budget buckets and handed to every lane through the owner port |
| Bank account | One setting per lane (income's, donation's); nothing makes them agree |
| Account a line books to | Expense: finance's category rules. Income: four fixed roles (sales, card remainder, fees, adjustments), not yet configured. Donation: looked up by name in QuickBooks at post time, so renaming an account there fails every post until finance fixes the name |

The books map holds bucket → Class (moved in as it is) and named role →
QuickBooks account id: each bank account, Shopify's four accounts, and
Benevity's donation, match and fee accounts. Finance edits it, and each edit is
audited. It lives beside the budget buckets, in checkin's database today, and
moves with them when checkin becomes a package. Every lane reads it through one
host-bound port, whose type lives in `@checkin/quickbooks`. The quickbooks
package itself stays a stateless client with no database.

No lane stores or looks up a QuickBooks id itself. Expense's category rules
stay in expense, since choosing the account for a kind of purchase is
expense's knowledge; they move to pointing at map roles later, with expense's
own posting work.

### Income owns every deposit

**Intake.** Income gains a port the host binds into bulk donation:

- `expectDeposit(source, sourceKey, expected)` records that money is due. The
  expected deposit carries the date, net amount, bank-account role and lines.
  Each line names an account role and a budget bucket; income resolves both to
  QuickBooks ids through the books map when it posts. Donation needs no
  QuickBooks client at all. Calling it again with the same source and key updates the
  row while it is unposted and changes nothing after.
- `depositStatus(source, sourceKeys)` answers, per key: waiting, booked,
  matched, with finance (and the note), or drifted.

Donation calls `expectDeposit` after the transaction that completes a
disbursement has committed, never inside it. Called inside, a rollback would
leave income a row for a disbursement that does not exist. A crash between the
commit and the call loses the call, so a re-send job calls `expectDeposit` again
for every completed disbursement income has not acknowledged; the call is
idempotent, so a repeat changes nothing. Donation reads `depositStatus` wherever
it shows or depends on the booking.

**Rows.** Income's reconciliation row gains a source (Shopify or Benevity) and a
source key beside the payout id, which becomes one source's key. Everything
downstream of the row (match before create, the key lookup and its marker, the
closed-books gate and switch-on, the per-run caps, drift, the lost-claim note,
the daily orphan sweep, finance's match, book-it and dismiss) runs unchanged on
either source. The unique deposit link on the row is now unique across every
source of incoming money, which is the whole fix.

**Two key formats on Benevity rows.** Income creates new deposits under its own
key. Deposits donation created before the switch carry donation's key,
`donation:<org>:<disbursement>`. On a Benevity row, income's look-first lookup
and its orphan sweep recognise both. Otherwise a deposit created by a donation
post that was still in flight at the switch would be neither found by the
lookup nor reported by the sweep, and income could create a second one.

**Finance.** Benevity rows appear in income's reconciliation queue with their
source shown. Finance resolves them with the same actions as payouts.

**Where donation's rules differ.** Donation's closed-books work shipped the same
rules as income's (switch-on per lane, UNBOOKED and book-it, the key lookup, the
orphan sweep), so they merge rather than collide. Three differences carry over
as per-source settings on income's side: donation's per-run cents cap, its
"uploaded after switch-on but dated in closed books" note, and its match window
of seven days either side of the disbursement. A narrower window could miss a
deposit finance booked by hand and create a second one. Donation's daily create
cap and its match-only handling of a disbursement over the cap do not carry
over; income's caps and its over-cap hold apply to both sources.

One difference does not carry over: drift. Donation keeps a drifted deposit
held in a separate column, so no other disbursement can take it before finance
looks. Income clears the link on drift, which frees the deposit. Under one
owner, income's rule applies to both sources. Every income row still competes
under the one unique link, and the drifted row goes to finance either way. The
move writes a drifted deposit into the row's note ("was linked to Deposit X,
which changed after it was matched") instead of adding a column for it.

### Expense owns every Purchase and Bill

Nothing changes. In-kind books journal entries, so it needs no port into
expense. If another part of the app ever needs a Purchase or Bill, expense
takes the request through an intake port and books it with its own machinery.

### In-kind

Each gift books as one journal entry: in-kind income credited, and each line
debited to in-kind expense or fixed assets (owner, 2026-10-25). In-kind owns
journal entries and clashes with nobody, so it needs no port to income or
expense. The app creates a journal entry only through an in-kind function that
refuses any account outside the in-kind roles.

Finance's earlier hand bookings went through a clearing account as a Deposit
and a Purchase. In-kind matches those pairs, but only entries in the clearing
account, which no other lane books to, so the rule above still holds: income
and expense never see them. Details are in `2182_IN_KIND_EXPENSE.md`, Posting to
QuickBooks.

## Migration

Prod holds no QuickBooks lane data (owner, 2026-10-26), so nothing moves. A
deployed release may still map a column, so a drop ships a release after the
code that stops using it.

1. **Income expands.** Source and source-key columns, the intake and status
   ports, per-source settings. Shopify behaviour is unchanged.
2. **Donation switches over.** Donation's posting job is switched off, and so
   are the QuickBooks actions on its resolve route (match, dismiss, retry and
   book), which answer that the disbursement's deposit is now income's. The
   route itself stays registered until step 3. The move script then waits
   until no donation post is in flight, meaning every post claim is older than
   the 10-minute stale time, and copies each disbursement's QuickBooks state into an
   income row: deposit link, booked total and date, match state,
   create-attempt time and note, with a drifted deposit written into the note
   (see "Where donation's rules differ"), and donation's exclusions into
   income's.
   The script stops on a deposit already held by a payout: that is a live double
   hold for finance to settle first. Donation then calls the ports instead of
   posting.
3. **Donation's QuickBooks lane goes.** Its routes, screens and posting code,
   the move, the cross-lane list and every fallback. Its QuickBooks columns stay
   mapped, neither read nor written.
4. **Contract,** a release after step 3 deploys: drop donation's QuickBooks
   columns and exclusion table, and move income's row index to organisation,
   source and key.

The script runs between donation's switch-off and its first call to the port,
so no disbursement is posted by both. It runs as the first step of donation's
daily hand-over job, which makes no port call until the move has set its marker.
A stop alerts finance once per cause, and the job tries again each day.

The hand-off was model-checked. Without any one of these four rules, the checker
found a run that booked one disbursement twice, booked one that never completed,
lost one, or left a stray deposit unreported: the call after the completion
commit with its re-send job, the wait for in-flight posts, recognising
donation's key, and switching off donation's poster and resolve actions in
PR 2. With all four, every run passed.

## PR split

0. **Books map.** The map beside the budget buckets in checkin's schema, its
   finance screen and audit, the port type in `@checkin/quickbooks`, and its
   binding into income. Seeded with what money-in needs: bank accounts, and
   Shopify's and Benevity's account roles.
1. **Income: second source.** Columns, ports, per-source settings, and income
   resolving accounts and Classes through the map. Shopify unchanged. Income
   package and its `configure.ts`. The row's payout-id column holds each
   source's key, and its unique index stays on organisation and that key: a
   Shopify payout id and a Benevity disbursement id cannot collide. A role the
   map leaves unset falls back to the host's environment setting where one
   existed (Shopify's bank and four line accounts, Benevity's bank).
2. **Donation: hand deposits to income.** The port calls after the completion
   commit, the re-send job, status reads, the one-off move script, the host
   binding, and the switch-off of donation's poster and of every QuickBooks
   action on its resolve route. Income's lookup and sweep recognise donation's
   key on Benevity rows. Bulk-donation package, its
   `configure.ts`, and the move script.
3. **Cleanup (done).** Migration step 3, with no migration. Deleted:
   - the `qb-candidates`, `qb-resolve` and `qb-exclusions` route files under
     `api/donations/`, and the QB Queue and QB Exclusions screens;
   - donation's QuickBooks posting code, and the one-off move;
   - every environment fallback for map roles, and the account names Benevity
     lines carried;
   - the cross-lane list, and the recognition of donation's key.

   Donation's QuickBooks columns and the move's marker stay mapped, unused,
   because the deployed release still reads them. It touches no boundary file:
   the four registry entries are left with no route, which is the inert
   register-first state.
4. **Registry removal (done).** Remove those four donation registry entries and the
   donation candidate view's classification. Boundary only. The decommission
   certifier reads `registry.ts` alone, not `registry/donation.ts`, so this
   ships on its own, with tests.
5. **Contract,** after 4 and a release after 3 deploys: migration step 4.
   - Drop the `qb_match_exclusion` table and its model. The registry entries
     that returned it go in 4.
   - Drop `disbursement_events`' `qb_*` columns, with their unique and state
     indexes.
   - Drop `donation_org_settings.qb_posting_on_at` and `deposits_handed_over_at`.
   - Move income's row index to organisation, source and key, and drop the
     source-mismatch refusal in `expectDeposit`. Reconcile then keys its rows
     by source and key, not by key alone.

**Security boundary and registry.** PR 4 removes whole registry entries whose
routes PR 3 deleted; PR 5 drops the model they returned. Income's reconciliation routes
return whole rows, so the new columns reach finance and the board as internal
fields under their existing entries. The resolve roles already match (OWN-3).
PR 0's finance screen adds routes: their registry entries land
first, each in its own PR based on `main`. PRs 1, 2, 3 and 5 add no route and
change no grant. In-kind's posting lane is #2182's own work.

## Open questions

- **OWN-1. Income's row.** Resolved: one table with a source column (owner,
  2026-10-25).
- **OWN-2. Account and Class lookups.** Resolved: one books map beside the
  budget buckets; it may move when checkin becomes a package (owner,
  2026-10-25). See "The books map".
- **OWN-3. Finance's queue and roles.** Resolved: income's reconciliation queue
  with the roles its routes grant today (owner, 2026-10-25). Nothing in either
  lane is signed off: only finance acts, a dismiss or a differing-amount match
  needs a reason, and every action is audited. The writes are finance-only in
  both lanes, so no registry change. The board keeps the queue and outcomes but
  loses the live QuickBooks candidates for Benevity batches, which it can read
  in donation today.
- **OWN-4. In-kind's shape.** Resolved: one journal entry per gift (owner,
  2026-10-25). See "In-kind".
- **OWN-5. The package name.** Resolved: keep "income" (owner, 2026-10-25).
- **OWN-6. Rules text.** Rules stay at board level: no new principle, one
  bullet under Donations, landing in PR 2 (owner, 2026-10-25). See "Rules".
