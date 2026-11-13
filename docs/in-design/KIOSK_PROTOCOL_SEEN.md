# Recording which scan protocol each kiosk speaks

The server keeps code for older kiosk builds. Nobody can safely delete it,
because the server forgets which build each kiosk is running as soon as the
scan is answered. This design records, per kiosk, the last protocol version
the server received and when.

## Decisions for the owner

Each has a recommendation. The design below is written to the recommendations;
another choice changes only the section named.

**KP-IDENT — how a kiosk is identified.**
- **A. By its signing key (recommended).** Each kiosk signs with its own
  key, and the server already finds which configured key matched. A short
  fingerprint of that public key is the kiosk's identity. The kiosk does not
  change.
- B. By a kiosk id the kiosk sends. This needs a kiosk build. Kiosk changes
  belong to the kiosk owner, and the id would be just another unsigned label
  unless it goes into the signed body.

**KP-STORE — what a row holds.**
- **A. One row per kiosk and version, with first and last seen
  (recommended).** The latest version for a kiosk is its row with the latest
  last-seen time. Each version also keeps the last time it was seen, so "has
  anything sent version 5 in the last 30 days?" is one lookup, even after the
  kiosk upgrades. The row count stays tiny: kiosks times versions.
- B. One row per kiosk, holding the latest version only. This is what the
  finding asks for, but an upgrade overwrites the evidence that an older
  version was seen recently.

**KP-WRITE — write cost.**
- **A. One upsert per scan (recommended).** Fire-and-forget after the scan,
  like the response-time metric the scan route already inserts on every scan
  (`checkin-app/src/app/api/scan/route.ts:577`). Last-seen is exact. No new
  state.
- B. Write only when the version changes, or when last-seen is more than an
  hour old, using an in-process cache. Fewer writes, but it adds a per-task
  cache and last-seen becomes approximate. Worth it only if scan volume
  grows by orders of magnitude.

**KP-VIEW — how the reading reaches System Status.**
- **A. The heartbeat route returns the new model (recommended).** This means
  a registry PR first, which adds the model to the route's `returns`. The
  registry then names where the data comes from.
- B. Synthesize `SystemMetricLog` rows with the fingerprint in the metric
  name (`kiosk_protocol:<fp>:<version>`). This needs no boundary PR, the same
  trick open PR #2375 uses for build strings. But the registry would then say
  `SystemMetricLog` for data that comes from another table.

**KP-WHO — who sees it.**
- **A. Sysadmins and Board members (recommended).** These are the same
  people who see the kiosk heartbeat today
  (`checkin-app/src/security/registry.ts:876`).
- B. Keyholders as well. Keyholders can open the health page, but the
  heartbeat box is not granted to them. A protocol number tells a keyholder
  nothing they can act on.

## Problem

The kiosk at the front door and the server are released separately. Each
time the scan message changed shape, the server kept a branch for kiosks
still sending the old shape. Those branches cover the repeat-read filter, how
late replays are treated, and how a keyholder's close is decided. They can
only go once no kiosk sends the old shape. Today the server reads the version
on each scan, acts on it, and keeps nothing, so nobody can say whether any
kiosk still needs the old branches.

## Objective

For each kiosk, the server records every protocol version it has received
and when each was first and last seen. Sysadmins and Board members can see
this on System Status. The kiosk owner can read off it when a version-gated
branch has had no traffic.

## Executive summary

- **Kiosk:** no change. The kiosk already sends its protocol version on
  every scan (`client/client.py:192`).
- **Scan path:** after each scan, the server upserts one small row. This
  never delays, fails or changes a scan.
- **Operators (sysadmin, Board):** the kiosk heartbeat box on System Status
  lists each kiosk key's protocol versions, with when each was last seen.
- **Kiosk owner:** gets the evidence for deleting old protocol branches.
  Deleting them is out of scope here.
- **Cost:** one new table, created by an expand-only migration. One upsert
  per scan. Three PRs.
- **Not changed:** what the server does with any version. No version is
  refused that is accepted today.

## Rules this relies on

From `docs/rules/attendance-checkin.md`, Kiosk resilience:

- *A badge scan, once read, is never lost.* The record is written outside the
  scan's transaction, and its failure is logged, never raised. A scan never
  waits on it.
- *The kiosk rests … this rests on the front door being the only scanner.*
  So today there is one kiosk and usually one key. The design still keys by
  signing key, because `KIOSK_PUBLIC_KEY` holds several keys during key
  rotation, and a second kiosk would get its own key.
- The rules that name "older kiosk builds" (the server's three-second check,
  holding late replays, a close decided from the keyholder's check-out)
  describe the branches this record lets the kiosk owner retire. This design
  changes none of them. The PR that deletes a branch also edits its rule.

No rule is added or changed. Nothing is expected to be extracted at merge.

## Design

### 1. How a kiosk is identified on the scan path

Today the scan route learns only that *some* configured key signed the
request:

- `checkin-app/src/app/api/scan/route.ts:63-66`: `withKiosk` hands the
  handler `auth`. The handler checks only `auth.type === 'kiosk'`.
- `checkin-app/src/lib/kioskAuth.ts:49`: `withKiosk` calls
  `authenticateRequest(req, rawBody)`.
- `checkin-app/src/lib/auth.ts:39`: on a verified signature it returns
  `{ type: 'kiosk' }`, with no identity.
- `checkin-app/src/lib/verify-kiosk.ts:63-92`: `signatureMatches` tries each
  key in `KIOSK_PUBLIC_KEY` (parsed at `:49`) and returns only a boolean.
- `checkin-app/src/types/auth.ts:38`: `AuthResult`'s kiosk arm has no fields.

Change:

- `signatureMatches` returns the matching key, or null.
- `verifyKioskSignature` (`verify-kiosk.ts:94`) returns
  `{ ok: true, keyFingerprint }`. The fingerprint is the first 16 hex
  characters of SHA-256 over the 32-byte public key. A public key is not a
  secret, and the fingerprint only names it.
- `auth.ts:39` passes it on: `{ type: 'kiosk', keyFingerprint }`.
- `AuthResult`'s kiosk arm gains `keyFingerprint?: string`. The field is
  optional, so every existing `{ type: 'kiosk' }` literal still compiles,
  including those in `src/security/` and its tests. No boundary file changes.
- The keyless local kiosk (`auth.ts:47`, `CHECKIN_ENV=local` with no key
  configured) has no fingerprint, so it is not recorded.

The attendance route re-verifies signatures itself
(`checkin-app/src/app/api/attendance/route.ts`). It carries no protocol
version, so it is left alone.

### 2. Where the record lives

No existing table fits. There is no kiosk table. `SystemMetricLog` is a
rolling log: the health route deletes every row older than 30 days on each
read (`checkin-app/src/app/api/system-status/health/route.ts:71`). The kiosk
heartbeat lives only in process memory (`checkin-app/src/lib/kioskSeen.ts`)
and is lost when the service scales to zero each night.

New model (KP-STORE A):

```prisma
/// The scan protocol versions each kiosk signing key has sent, and when.
/// One row per key and version. Rows are never deleted.
model KioskProtocolSeen {
  /// First 16 hex of SHA-256 over the kiosk's Ed25519 public key.
  /// @sensitivity:internal
  keyFingerprint  String
  /// The version the server acted on: an absent protocolVersion is 1.
  /// @sensitivity:internal
  protocolVersion Int
  /// @sensitivity:internal
  firstSeenAt     DateTime @default(now())
  /// @sensitivity:internal
  lastSeenAt      DateTime

  @@id([keyFingerprint, protocolVersion])
}
```

The tier is `internal`, the same as `SystemMetricLog`. It is a new model, so
the regenerated classifications change only by addition, which the boundary
isolation check exempts.

The recorded version is the one the server acted on. An absent
`protocolVersion` is read as 1 (`route.ts:197`), so it is recorded as 1. A
value that fails validation (`route.ts:147`) is not recorded. A version newer
than the server's, refused with 426 (`route.ts:190`), *is* recorded: it shows
a kiosk running ahead of the server.

**Migration: expand-only** (`docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
rule 1). It is one `CREATE TABLE` with the composite primary key and no
foreign keys, so rule 8's foreign-key index rule does not apply. Old tasks
draining during the rolling deploy never read or write the table. The app's
DML role gets privileges on the new table through the default privileges in
rule 9. The PR confirms that the AWS cluster bootstrap grants the same.
Nothing is contracted later.

### 3. Write cost (KP-WRITE A)

The upsert runs in the scan route's `finally`, next to the response-time
metric (`route.ts:574-582`). It is fire-and-forget: a rejected promise is
logged and never thrown.

```ts
prisma.kioskProtocolSeen.upsert({
  where: { keyFingerprint_protocolVersion: { keyFingerprint, protocolVersion } },
  create: { keyFingerprint, protocolVersion, lastSeenAt: now },
  update: { lastSeenAt: now },
})
```

The `where` names only the unique key and there are no nested writes, so
Prisma issues a native `INSERT … ON CONFLICT` on Postgres. Two scans at the
same moment cannot collide on create.

The cost is one single-row upsert per scan, on a route that already writes
the badge log, the visit and a metric row per scan. The write never runs
while the kiosk rests, because a resting kiosk sends no scans. So it cannot
wake the curfewed service or keep the database from pausing.

### 4. Where an operator sees it (KP-VIEW A, KP-WHO A)

The reading goes in the **Kiosk last seen** box on System Status → Health
(`checkin-app/src/components/admin/SystemHealthPanels.tsx:556`,
`KioskHeartbeatBox`). It shows one line per key fingerprint, latest version
first, with each version's last-seen time. A key no longer in
`KIOSK_PUBLIC_KEY` is labelled "key removed".

It is served by the existing `GET /api/system-status/kiosk-heartbeat`
(`checkin-app/src/app/api/system-status/kiosk-heartbeat/route.ts`), which adds
a `KioskProtocolSeen` array to its envelope.

Boundary entries (registry PR, before the route PR):

- `checkin-app/src/security/registry.ts:875`, the `defineRoute` for
  `GET /api/system-status/kiosk-heartbeat`. `returns` becomes
  `['SystemMetricLog', 'KioskProtocolSeen']`. `authorize` and `orderedView`
  are unchanged: sysadmin and Board, `everyones:internal`. The entry's
  comment is updated to say the route also returns stored rows.

No other route or view changes. The registry's `returns` is typed off the
generated classifications, so the registry PR can only build once the model
exists. That is why PR 1, which adds the model, comes first.

### 5. How this tells the kiosk owner when old code can go

Each legacy branch is gated on a version threshold
(`checkin-app/src/lib/scanProtocol.ts`):

| Below | Branch in `checkin-app/src/app/api/scan/route.ts` |
|---|---|
| 3 | the server's own three-second repeat-read check (`:352-353`) |
| 5 | late, out-of-order or doubtful-clock replays are held instead of applied (`:355-356`) |
| 6 | a keyholder's check-out decides the close (`:197`, `LegacyKiosk`) |

A branch gated below version N can be deleted when both hold:

1. Every kiosk key still configured has its latest version at N or above.
2. No row with a version below N has been seen for a quiet period the kiosk
   owner picks, long enough to cover a kiosk that was off and comes back on
   an old build.

One part of the legacy handling is not gated on a version: the old close
fields `forceCloseConfirmed`, `forceCloseToken` and a bare `shownEmpty`
(`route.ts:117-125`). The kiosk stamps the version of the build that *sends*
a scan, not the build that queued it (`client/client.py:192`). So a close
queued by an old build and replayed after an upgrade arrives labelled with
the new version. Deleting those fields needs one more condition: the kiosk's
queue has been empty since the upgrade. The heartbeat's queued count shows
this (`kioskSeen.ts`, `buildingLink`).

This record is evidence. It does not grant permission. The deletion PR, and
the rule edits it carries, belong to the kiosk owner.

### 6. PRs, in order

All are based on `main` and none is stacked. Each one waits for the previous
one to merge.

1. **Record the version.** Code PR. The `KioskProtocolSeen` model and its
   migration; the regenerated classifications (additions only); the matching
   key and fingerprint through `verify-kiosk.ts`, `auth.ts` and
   `types/auth.ts`; the upsert in the scan route; tests for the fingerprint,
   the upsert, and a scan that still succeeds when the upsert rejects. No
   boundary file changes.
2. **Registry entry.** Boundary PR. The `returns` change in
   `checkin-app/src/security/registry.ts` (§4) and its security test, and
   nothing else.
3. **Show it.** Route and UI PR. The heartbeat route reads the table and
   returns the rows. `KioskHeartbeatBox` renders them.

If the owner picks KP-VIEW B, PR 2 drops out and PR 3 synthesizes
`SystemMetricLog` rows instead.

## Alternatives considered

- **Keep it in process memory, like the heartbeat.** It would be lost every
  night when the service scales to zero, and after every deploy. The kiosk
  owner's question spans weeks.
- **Rows in `SystemMetricLog`.** The 30-day purge erases the evidence. The
  table also has no column for the kiosk.
- **Log lines only.** A log could answer the question, but only by hand
  through CloudWatch, with nothing on System Status.

## Related

- Finding PR2892-F01 (audit item C124a) asked for this record.
- Open PR #2375 reports the kiosk's *build* (release and file digest) in an
  unsigned header, held in memory. That shows what software a kiosk runs. This
  design records the signed protocol version that decides which server
  branches run. The two do not overlap, and this design does not depend on
  #2375.
