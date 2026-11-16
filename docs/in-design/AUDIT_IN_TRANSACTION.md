# Audit rows commit with the change they record

## Problem

Every change to standing, money or access is supposed to leave a record of who
made it. In many places the app saves the change first and the record second, as
two separate saves. If the second save fails — the server restarts, the database
connection drops, the record is malformed — the change stays and its record is
gone. Nobody is told. Later, when someone asks who moved a person between
households or who removed a volunteer from a program, the trail has nothing to
say.

## Objective

A change and its audit record are saved as one unit: both are kept, or neither
is. New code cannot quietly reintroduce the two-step pattern, because a guard
fails the build when it does.

## Executive summary

- **Staff and families:** nothing visible changes. A request that used to
  succeed with a lost record now fails as a whole and can be retried.
- **Board and anyone reading the trail:** every change made through the app has
  its record. The records that are deliberately kept even when nothing changed —
  refusals, attempts at outside systems, webhook receipts — keep working as they
  do now.
- **Developers:** one helper writes an audit row, and it is called with the
  transaction that made the change. A guard test lists every place that still
  writes through the root client, each with its reason; the list only shrinks.
- **Out of scope:** the library packages' own audit tables, audit rows that are
  already written inside their change's transaction, and the shape of existing
  audit payloads beyond what the helper requires.
- **Cost:** about six small PRs over the app's routes and libraries, plus the
  helper-and-guard PR first.

## Rules relied on or changed

- `docs/rules/principles.md` → *Accountability*: "Anything that changes
  standing, money, or access is attributable", and "A system actor names
  itself". This work makes the first true under failure, not just on the happy
  path.
- Proposed new rule for `principles.md` → *Accountability*, extracted at merge:

  > **An audit row commits with the change it records.** A change and its row
  > are written in one transaction, so neither survives without the other. The
  > exceptions are rows that record something other than a committed change — a
  > refusal, an attempt at an outside system, an inbound delivery — which are
  > written on their own so they survive the failure they describe.

## Design

### The helper

`recordAudit`, in `checkin-app/src/lib/auditActor.ts`, next to the actor helpers
it depends on:

```ts
export type AuditEntry = {
    action: AuditAction;
    tableName: string;
    affectedEntityId: number;
    secondaryAffectedEntity?: number | null;
    oldData?: Prisma.InputJsonValue;
    newData?: Prisma.InputJsonValue;
};

export function recordAudit(tx: TxClient, actor: AuditActor, entry: AuditEntry) {
    return tx.auditLog.create({ data: { ...actor, ...entry } });
}
```

Why this shape, and not something larger:

- **Reuse first.** The transaction plumbing already exists: `withTx` in
  `lib/db-client.ts` opens a transaction on the root client or a savepoint inside
  a caller's. The actor plumbing already exists: `personActor` refuses a missing
  actor, `systemActor` names an automated path from a closed list. `recordAudit`
  only joins them. It adds no transaction of its own.
- **The actor is a separate parameter of type `AuditActor`.** A caller has to go
  through `personActor` or `systemActor` to get one, so a hand-built
  `actorId: auth.user.id` with no check is no longer possible at a call site that
  uses the helper. That closes the second half of the problem — hand-built
  payloads that skip the fail-closed actor check — at every site this work
  touches.
- **The first parameter is named and typed `tx`.** The type does not stop a
  caller from passing the root client, because Prisma's root client is assignable
  to its transaction-client type. The guard below closes that gap; the name makes
  the intent obvious in review.
- **The existing per-file `audit(tx, …)` helpers** in the trusted-adult service,
  membership review and household background-check settlement already write
  inside their transactions. They stay as they are. Rewriting them onto
  `recordAudit` is churn with no failure to fix.

### The rule in code

1. The change and its audit row are written with the same transaction client.
2. Where the change already runs in `prisma.$transaction(async (tx) => …)`, the
   audit write moves inside the callback and uses `tx`.
3. Where the change is a single statement on the root client, the change and the
   audit are wrapped together in `prisma.$transaction`.
4. Where the change is made by a library function that only takes the root
   client, that function gains a `db: DbClient` parameter and runs its work
   through `withTx(db, …)`, the same way `addHouseholdLead` and the emergency
   contacts service already do.
5. Anything that talks to an outside system — an email, a Shopify inventory
   adjustment, a Zoho request, a Lambda invoke, a cache invalidation — stays
   after the transaction commits, as it is today. Moving the audit write inside
   does not move these inside.
6. A value only known after commit — an outside system's reply — is not put in
   the committed row. The outside outcome is already reported through the logger
   and error alerts; if a record of it is needed, it is a second row written
   after commit, described under the edge cases.

### Edge cases

**Refusals.** A refused request changes nothing, so there is no transaction to
share. `recordSelfGrantRefusal`, the mail-alias refusal, and similar rows are
written on the root client on purpose: they must survive the refusal they
describe. They stay outside, and both are in the guard's allowlist with that
reason.

**Attempts at outside systems.** Some rows record that someone asked the app to
do something outside it — start a Shopify sync, retry a failed step in a
library. The sync row is written before the call; the retry row is written
after, with whether it worked. Both must commit whether or not the outside call
succeeds, so they stay on the root client.

**Inbound deliveries and summaries.** The Shopify webhook receipt row records
that a delivery arrived. The nightly sweep's summary row is a notice to the
board; each visit it closed already has its own row inside that visit's
transaction. Neither records a change of its own, so both stay outside.

**Observations with no change.** The refund reconciliation's "seat restocked
after withdrawal" row records that the app saw a withdrawn enrollment and changed
nothing. It stays outside.

**Audited reads.** No app route writes an audit row for a read today. If one is
added, it has no change to share a transaction with and is written like a
refusal: on its own, and listed in the allowlist.

**Rows that must commit even when the change fails.** Covered by the three cases
above: each is a row whose subject is the attempt, not the change. A row whose
subject is the change never needs this, and is never written outside.

**Dev-only routes.** The mock Shopify order route writes a marker row for the
dev store. It is listed in the allowlist as dev-only and is not changed.

**Library packages.** `packages/expense`, `packages/receipt` and
`packages/workflow-mapping` write their own audit tables
(`ExpenseAuditLog`, `ReceiptAuditLog`, `WorkflowAuditLog`) through their own
repositories and services. They are out of scope: separate schemas, separate
helpers, separate owners. The guard does not scan them. Whether their writes
share a transaction with their changes is worth its own check, but not here.

### The guard

A unit test, `checkin-app/src/lib/__tests__/auditInTransaction.test.ts`, reads
every `.ts` file under `checkin-app/src` (excluding tests) and fails on any
`prisma.auditLog.create(Many)` or `db.auditLog.create(Many)` not in its
allowlist.
Each allowlist entry is a file path, its match count and a one-line reason from
the edge cases above. It also fails when a file has fewer matches than its entry
says, so the list cannot go stale.

The guard matches the root client by its import name, `prisma`, and the
`DbClient` parameter by its conventional name, `db`. The six `db.` sites — the
kiosk-leave and close-departure loggers, the trusted-adult and membership-review
`audit` helpers, and the refusal recorder — stay on the allowlist for good, so a
new helper of that kind shows up in review. What the guard cannot check is what
a caller passes to such a helper: their callers today all pass a transaction
client except the refusal paths. That is an accepted limit: a text guard cannot
follow a value through a parameter, and narrowing those parameters to `TxClient`
would not be enforced by the type either.

No eslint rule. The repo's existing drift guards are tests, and a test can carry
a reasoned allowlist that a lint rule would carry as suppression comments, which
`AGENTS.md` forbids.

### How each PR proves itself

1. **The guard.** Each fix PR deletes its files' entries from the allowlist.
   Moving one of its audit writes back onto the root client fails the guard.
2. **A behavioural test per PR**, at the integration tier, for one
   representative route in its area: make the root client's audit write throw,
   call the route, and assert that no change was committed without its row.
   Code that writes the audit through `tx` never reaches the root client and
   passes; code that writes it after the change commits leaves the change behind
   and fails. Integration tests run in CI; authors do not run them locally.
3. **Existing unit tests** that assert `prisma.auditLog.create` was called are
   updated to the transaction client. A test that still asserts the root client
   is the cue that a site was missed.

## Alternatives considered

- **A wrapper that runs the change and writes the row** —
  `audited(db, actor, async (tx) => ({ result, entry }))`. It makes "same
  transaction" structural rather than checked. Rejected for now: half the sites
  already have a transaction callback with locks and capacity checks inside, and
  threading a return shape through them is a larger diff than moving one call.
  Worth revisiting if the guard's allowlist keeps attracting new entries.
- **A database trigger** writing audit rows. It would capture every change, but
  it cannot know the actor or the reason, which is what the accountability rules
  ask for.
- **An eslint rule.** See the guard section.

## Provenance

Raised by the architectural review of checkin-app; the owner approved the fix on
2026-11-15, starting with this design. The cutover — the site inventory and the
PR split — is in `AUDIT_IN_TRANSACTION-migration.md`.
