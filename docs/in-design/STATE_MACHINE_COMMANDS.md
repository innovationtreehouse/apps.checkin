# State machines: the table names the move, the machine makes it

Design for #3796. The one-time cutover (counts, write sites, PR order, the order
the other machines follow) is in `STATE_MACHINE_COMMANDS-migration.md`.

## 1. Problem

Several records in the app move through a fixed set of states. A household's
membership is none, active, revoked or denied; an application moves from intake
through payment and a background check to active or closed; a program enrollment
moves from pending to active or withdrawn. Each of these machines is written down
as a table of allowed moves, and diagrams and reports are generated from it.

The table describes the code but does not control it. Each piece of code that
moves a record names its own target state and writes it. Nothing connects that
write to a row of the table, so the two can disagree, and the first sign is a
record in a state nobody can explain. What stops new code from writing a state
directly is a test that searches the source with text patterns and checks each
file against a hand-kept count of allowed writes. A pattern search cannot be
shown to be complete: a write spelled differently passes it, and a correct new
write fails it until someone edits the count.

The owner set two bars for any fix:

1. **It never refuses a user who made no mistake.**
2. **It relies on no lists, regular expressions or source scanners.**

Two earlier designs failed them. One threw on any move missing from the table,
which refuses a user the first time a rare but legitimate move happens. The
other enforced "only the helper writes" with a build-time source checker, which
is a scanner.

## 2. Objective

For each converted machine:

- A command names an **event**. The machine's event table gives the states the
  event leaves from and the state it lands in. A command cannot name a move the
  table lacks, because it never names a move at all.
- Only the machine's own module can write its state columns. Anywhere else, a
  write to them **fails to compile**.
- Nothing decides a move from the audit log. State the code reads back is a
  column on the row.

## 3. Executive summary

| Who | What changes | What stays the same |
|---|---|---|
| Members, applicants, the board | Nothing visible. Every command refuses in exactly the cases it refuses today. | Every screen and message. |
| Code that moves a record | It calls `apply(db, MACHINE, id, "event", …)` instead of writing `status`. | Its own preconditions, locks and audit details stay at the command. |
| Code that reads a record | Nothing. Reads of `status` are untouched. | |
| Tests and the dev seed | They write fixture states through a named fixture client instead of the app client. | The states they can create. |
| CI | The text-pattern guards are deleted, machine by machine, as the compiler takes over. | Lifecycle drift detection still runs. |

The cost is a one-time change to how the app's database client is typed, and a
mechanical rewrite of each machine's write sites. The household machine goes
first because it has one writer already and needs no data migration; the
migration file gives the order for the rest.

## 4. Design

### 4.1 A machine declares its events, and its table is derived from them

A machine module declares each event once: the states it leaves from, the state
it lands in, and who performs it. The transition table that drives the diagrams
and reachability reports is computed from the events, so the two cannot differ.

The household machine, as it would read:

```ts
// lib/membership/householdStatus.ts
export const HOUSEHOLD = defineMachine({
    model: "OrgMembership",
    states: ["NONE", "ACTIVE", "REVOKED", "DENIED"],
    create: { to: "NONE" },
    events: {
        converge: { from: ["NONE", "REVOKED", "ACTIVE"], to: "ACTIVE", actor: "system" },
        revoke:   { from: ["ACTIVE"],                     to: "REVOKED", actor: "board" },
        deny:     { from: ["NONE", "ACTIVE", "REVOKED"],  to: "DENIED", actor: "board" },
        restore:  { from: ["DENIED"],                     to: "NONE",   actor: "board" },
    },
    // The row's householdId goes on the audit row and into the hook.
    secondary: "householdId",
    // Lazy, so this definition stays importable from pages and the generator CLI.
    onEnter: { DENIED: async (tx, row, actor) => (await import("./denial")).applyHouseholdDenial(tx, row.householdId, actor) },
});

export const TRANSITIONS = transitionsOf(HOUSEHOLD); // feeds machineSpecs.ts unchanged
```

An event whose source state equals its destination (`converge` from `ACTIVE`) is
a successful no-op, as `setHouseholdStatus` treats it today.

Event names are a typed union: `apply(db, HOUSEHOLD, id, "deni", …)` does not
compile. The table's prose `guardSite` column is no longer needed, because the
event name is the link to the command; the derived rows fill it with the event
name so the generated artifacts keep their shape.

### 4.2 One engine applies an event

`lib/lifecycle/machine.ts` holds the generic engine. It is the only code that
writes a sealed column (section 4.3).

```ts
type ApplyOptions<M> = {
    actor: AuditActor;
    reason: string;
    /** Extra compare-and-set conditions, for example `{ paidAt: null }`. */
    where?: SealedWhere<M>;
    /** Columns the machine does not own, written in the same statement. */
    with?: SealedData<M>;
    /** Extra fields for the audit row's newData. */
    audit?: Record<string, JsonValue>;
};

type Applied<S> = { applied: true; from: S; to: S } | { applied: false; at: S | null };

apply<M extends Machine>(db: DbClient, machine: M, id: number, event: EventOf<M>, opts: ApplyOptions<M>): Promise<Applied<StateOf<M>>>;
create<M extends Machine>(db: DbClient, machine: M, data: SealedCreate<M>): Promise<{ id: number }>;
```

Inside one transaction (a savepoint when `db` already is one), `apply`:

1. reads the row's current state;
2. returns `{ applied: false, at }` if that state is not in the event's `from`;
3. returns success without writing if the state is already the destination;
4. writes the destination with a compare-and-set on the state it read, plus
   `opts.where`, in one statement that also writes `opts.with`;
5. returns `{ applied: false }` if the compare-and-set matched no row;
6. writes the audit row and runs the machine's `onEnter` hook for the destination.

That is `setHouseholdStatus` today, made generic. The command keeps everything
that is about *why* the move is allowed: who may do it, conflict-of-interest
checks, locks taken before the read, and follow-on work. Recommendation C of the
review, "guard the event, not the edge", is this split: the table answers *where
to*, the command answers *whether now*.

### 4.3 Only the machine module can write its columns: the sealed client

The app's database client, and every transaction it opens, is typed so that a
machine's columns cannot appear in write data. The type is generic over
Prisma's own type map; its only input is a registry naming each machine's
columns:

```ts
// lib/lifecycle/sealed.ts
type Governed = { OrgMembership: "status"; OrgMembershipProcess: "status" };
```

For each model, the sealed column set is its own machine columns plus every
relation field that points at a governed model. The relation fields are read
from Prisma's payload types, not listed by hand, so a nested write such as
`household.update({ data: { orgMembership: { update: { status } } } })` is
sealed too. Today that seals six models: the two governed ones, `Household`,
`Person`, `ClearanceStepFailure` and `BackgroundCheckAttestation`.

On a sealed model, `create`, `createMany`, `update`, `updateMany` and `upsert`
accept every field except the sealed ones. The `…AndReturn` variants are absent.
A sealed field accepts only an unconstructable brand type, so the compiler names
the reason:

```
error TS2322: Type '"ACTIVE"' is not assignable to type 'WrittenOnlyByItsMachine'.
```

The sealed delegate's write methods are function-typed properties rather than
methods, so TypeScript checks their parameters strictly. As a result a sealed
transaction is not assignable to Prisma's full `TransactionClient`: a function
still typed with the full client fails to compile when handed the app's client.
That makes the switch total. There is no annotation that quietly reopens the
column.

`@/lib/prisma` exports the client as `SealedClient`; `TxClient` and `DbClient`
in `lib/db-client.ts` become the sealed types. The engine in 4.2 obtains the full
delegate through one cast, in one function, in one file, and exports no way to
reach it.

A prototype of the type against the generated client compiled cleanly. Direct
writes through every write method, writes inside `$transaction`, writes in
`createMany` arrays and nested relation writes all failed to compile; flag
writes, foreign keys, other models, and `select`/`include` results compiled
unchanged.

### 4.4 Tests and the dev seed write fixtures through a fixture client

Tests and the dev seed create records in arbitrary states, including states no
command reaches quickly. They use `fixtureClient` from `lib/dev/fixtureClient.ts`,
which is the unsealed client under its own name. The dev seed already runs from
`lib/dev/`, behind its dev-only guard. A file that imports it is visibly
writing fixtures; production code has no reason to.

### 4.5 Accepted risks

Each of these can still write a sealed column. Each is visible in review as what
it is, and none exists in production code today.

| Hole | Why it is accepted |
|---|---|
| A type cast (`as unknown as PrismaClient`) | `AGENTS.md` forbids fixing a type error by coercion, and a cast at a call site is visible in the diff. |
| Raw SQL (`$executeRaw`) on a governed table | None exists. Recommendation E's optional log-only trigger is the detector if that changes. |
| A second `new PrismaClient` | Today only test observers, `prisma/seed.ts` and one script build one. They write fixtures or nothing. |
| `fixtureClient` imported by production code | Its name says what it is. |
| psql, migrations, one-off scripts | Outside the compiler. A migration that moves state is reviewed as one. |

### 4.6 How each part meets the two bars

| Part | Bar 1: no refusal of a user who made no mistake | Bar 2: no lists, regex or scanners |
|---|---|---|
| Events and the derived table (4.1) | An event's `from` set is the set each call site passes today; moving it into the table adds no refusal. There is no "undeclared edge" check that could fire in production, because a command names an event, never an edge. | The event union is a type. A missing event is a compile error at the command that needs it. |
| The engine (4.2) | It refuses only when the row is not in a state the event leaves from, or a concurrent write won the compare-and-set: today's refusals. | No inspection of source. |
| The sealed client (4.3) | It acts only at compile time. | The registry is the machine definition, not a list of call sites or files; relation fields come from Prisma's types. No source is read. |
| Fixture client (4.4) | Tests only. | A named export. |
| Moving audit-log state into columns (migration file, recommendation B) | The column is backfilled from the same audit rows the code reads today, so every decision reads the same answer. | Removes a JSON lookup; adds nothing. |

## 5. Open questions

The IDs are fixed; a settled question is struck, never renumbered.

### OQ1. How does an event name its destination when the facts choose it?

For the household machine every event has one destination. For applications,
seven (state, event) pairs have several destinations and the facts choose among
them. A payment on an application at `PENDING_PAYMENT` lands in:

| Facts | Destination |
|---|---|
| Check cleared, no dispute, agreement signed | `ACTIVE` |
| Agreement unsigned | `PENDING_EXTERNAL_ACTION` |
| Otherwise | `PENDING_BG_CLEARANCE` |

Two ways to keep "the table names the destination":

- **(a) Outcome-named events.** The table holds `activate.cleared`,
  `activate.unsigned` and `activate.held`, each with one destination. The command
  decides which outcome applies and names it. Enrollment already works this way
  (`T4 activate(held)`, `T4 activate(denied)`).
- **(b) A pure `outcome(facts)` per event.** The table holds `activate` with a
  function from facts to destination. The command loads the facts under the lock
  and passes them.

**Proposed answer: (a).** Every move stays a plain row in the table, which the
diagrams, the reachability report and the TLA+ models already read. With (b), a
reader has to run a function to know where an event can land, and the table
becomes code. The cost of (a) is more event names: the seven fan-out pairs
become 29 outcome events.

### OQ2. How does the convention change?

`docs/conventions.md` says "A state machine describes the database, it does not
drive it": the definition is "never an engine". Section 4.2 makes the
definition choose the destination, so the convention must change in the same PR
as the engine. Proposed replacement for its first bullet, for the owner to
approve or reword:

> **Where an entity's states are written down, the definition says where each
> event lands and the database decides whether it can land.** A command names
> an event; the definition gives its source states and its destination. The
> compare-and-set update, the row lock and the partial unique index stay the
> enforcement. The definition holds no preconditions: who may act, and on what
> facts, stays in the command.

The other three bullets (one atomic write per transition, an invariant encoded
once, redelivery is not repair) stand unchanged.

### OQ3. Which audit-log reads become columns, and in what order?

All of these belong to the application machine; none blocks the household
machine. Each decides a move or a guard from audit-log JSON today:

| ID | Where | What it reads | What it decides | Proposed column (shape to settle in its PR) |
|---|---|---|---|---|
| B1 | `settleHouseholdBg.ts` `recordedBlock` | `blockingReviewIds`, `reason`, the status it was blocked from | Which step a blocked application resumes to, and whether this code may move it | `blockedFromStatus`, `blockedByReviewIds Int[]`, `blockedBy` enum |
| B2 | `checkStanding.ts` `reviewHoldsRejection`, `loadCheckReviews` | rejection and sent-back history | Whether a check review may be closed or dismissed; a person's check standing | `heldRejection Boolean`, `sentBackAt` |
| B3 | `review.ts` `wrongPersonClosedAt` | `newData.action` on the last close | Whether a closed review may be reopened by the board | `archivedReason` enum beside `archivedFromStatus` |
| B4 | `archive.ts` `deniedSinceClose` | the close's `reason`, the household's later DENIED rows | Whether Reopen refuses because the household was denied since the close | `archivedReason`, and the household's `deniedAt` |
| B5 | `review.ts` `dismissCheckStarted` | the CREATE row's `checkStarted` | Whether dismissing closes the review | `openedBy` enum |
| B6 | `review.ts` `reopenPeople` | `subjectPersonId` history | Whom a reopened review counts against | a `CheckReviewFormerSubject` join table |
| B7 | `reconcile/membership.ts` `refundRecordedOn` | `refundRecorded` and the old order id | Whether the reconciler treats a refunded order as accounted for | `refundedOrderId` |
| B8 | `reconcile/membership.ts` `howYearWasSettled` | `via: "manual"`, `grantedYear` | How a paid year was settled | `settledVia` enum |

**Proposed answer:** B1 to B4 first, one migration each, because they choose a
destination or a guard on the application machine and its conversion depends on
them. B5 to B8 follow in any order. Each adds the column, backfills it from the
audit rows the code reads today, switches the reader, and leaves the audit
writes in place.

### OQ4. Is `fixtureClient` the way tests and the seed write states?

The measurement in the migration file shows 166 fixture writes of household
status across 76 test files, and the seed's own client. The alternatives are to
drive every fixture through commands, which is slow and impossible for states no
command reaches, or to give the seed its own command per state, which is a
second engine.

**Proposed answer:** yes, `fixtureClient` from `lib/dev/fixtureClient.ts`, the
unsealed client under a name that says what it is for. It sits in `lib/dev/`
because the dev seed runs there on the dev instance, not only in tests. The dev seed already builds its
own client in `prisma/seed.ts`; it keeps it, typed as the fixture client.

## 6. Alternatives considered

- **A runtime check that refuses any move missing from the table, with a lint
  rule naming the only writer.** Fails bar 1: a legitimate move missing from the
  table refuses a user, and the table cannot be shown complete. Fails bar 2: the
  lint rule is a source checker.
- **Database triggers per state column, plus a type-aware build check.**
  Enforcing triggers fail bar 1 for the same reason. The build check fails bar 2.
  A trigger that only logs meets both bars; it is a detector, kept as optional
  recommendation E.
- **A workflow engine or state-machine library.** The problem is who may write
  and where hidden state lives, not how the machine is expressed.
- **Database column privileges.** Postgres can deny `UPDATE (status)` to the
  app's role, but the engine runs as the same role in the same connection. A
  second role would mean a second connection pool and a second transaction,
  which breaks the one-atomic-write rule.
