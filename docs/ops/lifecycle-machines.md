# Lifecycle machines — running and regenerating

Three machines are written down, each as one declarative definition with its
legal states and its transition table:

- **Enrollment** (`ProgramParticipant.status`): a participant's place in a program, from
  unenrolled through payment or a scholarship hold to active.
- **Membership process** (`OrgMembershipProcess.status`): one application or
  renewal, from intake through review and payment to active or archived.
- **Household status** (`OrgMembership.status`): whether the household is a
  member — NONE, ACTIVE, REVOKED or DENIED. Only a membership process converging
  (paid and check cleared) makes it ACTIVE; DENIED's one exit is the board's
  restore to NONE. `setHouseholdStatus` is its one writer, and
  `noRawStatusWrites.test.ts` fails CI on a status write anywhere else.

Enrollment and the membership process also name the query filter for each state
set and a `validate()` that flags rows sitting off the diagram.

**Not modelled: the grace layer (backlog M1).** Household status has no GRACE or
INACTIVE state and nothing moves an ACTIVE household on when its year runs out
unpaid. Lapse is a manual board revoke until M1 is designed. The membership
process ends at ACTIVE or ARCHIVED and does not cover it either.

The rules those machines exist to hold are in `docs/rules/`; the discipline they
are built on is in `docs/conventions.md`. This file is how you operate them.

## Where things are

Run everything below from `checkin-app/`.

| Thing | Path |
|---|---|
| Shared primitives (state sets, transitions, classify/validate, enum parity) | `src/lib/lifecycle/` |
| Enrollment machine | `src/lib/programs/enrollmentState.ts` |
| Membership process machine | `src/lib/membership/lifecycle.ts` |
| Household status machine and its writer | `src/lib/membership/householdStatus.ts` |
| Generated diagrams, coverage matrix, reachability | `docs/generated/lifecycle/` |
| Off-diagram sweep | `src/lib/lifecycleDrift.ts`, `src/app/api/cron/lifecycle-reconcile/` |

## Regenerating the artifacts

The files under `docs/generated/lifecycle/` are machine-derived. **Never hand-edit
them.** After changing any machine's transitions, states, or the metadata the
artifacts render, regenerate and commit the result in the same change:

```bash
npm run generate:lifecycle-artifacts
```

The drift test regenerates in memory and compares byte-for-byte, so a stale
checked-in artifact fails CI. If the generator's own output format changes, this
is also the step that updates every artifact at once.

## Reading a red lifecycle test

Six guards cover this area, and each fails for a different reason:

- **Artifacts drift** — a machine changed and the generated files were not
  regenerated. Run the command above.
- **Guard ↔ transitions parity** — a compare-and-set guard's from-state no longer
  matches the transition table. The guard takes its from-state from the table;
  reconcile them rather than editing one side.
- **Status-literal allowlist** — new code hand-codes a set of statuses instead of
  consuming a state set's query filter. Consume the definition, or add an
  allowlist entry with a justification.
- **State-space safety** — the bounded state space is enumerated exhaustively and
  `classify` and `validate` disagreed somewhere in it. One of the two is wrong.
- **Enum parity** — a status was added to or removed from the Prisma enum without
  the machine's local union following.
- **No raw status writes** — code writes `OrgMembership.status` or
  `OrgMembershipProcess.status` outside a declared helper, or an allowlisted
  file's write count changed. Route the write through the machine's helper, or
  drop the allowlist row once its file has moved onto it.

## Off-diagram rows in production

A cron sweep scans the enrollment and membership-process models with their own
`validate()`. Household status has no sweep: every status is a legal resting
state. The sweep repairs one case on its own — an enrollment holding a seat it
has already been granted — by releasing the seat back to the store. Everything
else is reported to the sysadmin and board channel, and shows up in System Status
under **Lifecycle**, for a person to resolve. Nothing ambiguous is changed automatically.

This is distinct from the store reconciliation cron, which recovers rows that are
*on* the diagram but stuck at a checkpoint because a webhook never arrived.
