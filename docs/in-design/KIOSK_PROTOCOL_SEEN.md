# Recording which scan protocol each kiosk speaks

The server keeps code for older kiosk builds. Nobody can safely delete it,
because the server forgets which build each kiosk is running as soon as the
scan is answered. This design records, per kiosk, the last protocol version
the server received and when.

## Decisions

The owner ruled on each of these on 2026-11-13. The design below follows the
rulings.

- **KP-IDENT: a kiosk is identified by the signing key that verified it.**
  The identity is a short fingerprint of that public key. The kiosk does not
  change. There is one kiosk today.  [Decision — owner]
- **KP-STORE: one row per kiosk, holding its latest version and when it was
  last seen.** Kiosks do not move back to older builds, so the latest
  version is all that is needed. There is no per-version history and no
  first-seen time.  [Decision — owner]
- **KP-WRITE: one upsert on every scan.** Each upsert also refreshes the
  last-seen time.  [Decision — owner]
- **KP-VIEW: the kiosk heartbeat route returns the kiosk row.** A boundary
  PR adds the model to the `returns` of
  `GET /api/system-status/kiosk-heartbeat`.  [Decision — owner]
- **KP-WHO: sysadmins and Board members see it**, the same people who see
  the kiosk heartbeat today.  [Decision — owner]

## Problem

The kiosk at the front door and the server are released separately. Each
time the scan message changed shape, the server kept a branch for kiosks
still sending the old shape. Those branches cover the repeat-read filter, how
late replays are treated, and how a keyholder's close is decided. They can
only go once no kiosk sends the old shape. Today the server reads the version
on each scan, acts on it, and keeps nothing, so nobody can say whether any
kiosk still needs the old branches.

## Objective

For each kiosk, the server records the protocol version it last received and
when. Sysadmins and Board members can see this on System Status. The kiosk
owner can read off it when no kiosk needs a version-gated branch any more.

## Executive summary

- **Kiosk:** no change. The kiosk already sends its protocol version on
  every scan (`client/client.py:192`).
- **Scan path:** after each scan, the server upserts the kiosk's one row.
  This never delays, fails or changes a scan.
- **Operators (sysadmin, Board):** the kiosk heartbeat box on System Status
  shows each kiosk's current protocol version and when it was last seen.
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

New model, one row per kiosk (KP-STORE):

```prisma
/// The scan protocol version each kiosk signing key last sent, and when.
/// One row per key. Rows are never deleted.
model KioskProtocolSeen {
  /// First 16 hex of SHA-256 over the kiosk's Ed25519 public key.
  /// @sensitivity:internal
  keyFingerprint  String   @id
  /// The version the server acted on: an absent protocolVersion is 1.
  /// @sensitivity:internal
  protocolVersion Int
  /// @sensitivity:internal
  lastSeenAt      DateTime
}
```

The tier is `internal`, the same as `SystemMetricLog`. It is a new model, so
the regenerated classifications change only by addition, which the boundary
isolation check exempts.

What is recorded:

- An absent `protocolVersion` is recorded as 1, because the server reads it
  as 1 (`route.ts:197`).
- A request the route refuses with 400 is not recorded. That includes a
  `protocolVersion` that fails validation (`route.ts:147`).
- A version newer than the server's, refused with 426 (`route.ts:190`), *is*
  recorded. It shows a kiosk running ahead of the server.

§3 places the write so that these hold.

**Migration: expand-only** (`docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
rule 1). It is one `CREATE TABLE` with a single-column primary key and no
foreign keys, so rule 8's foreign-key index rule does not apply. The file
opens with `BEGIN;` and ends with `COMMIT;`, as rule 5 requires of every new
migration; no `-- no-transaction:` escape applies. Old tasks
draining during the rolling deploy never read or write the table. The app's
DML role gets privileges on the new table through the default privileges in
rule 9. The PR confirms that the AWS cluster bootstrap grants the same.
Nothing is contracted later.

### 3. Write cost (KP-WRITE)

The route's `finally` (`route.ts:574-582`) runs on every exit, including the
early 400 returns, so the write is guarded by a value set only once a request
has passed validation:

- `let seenVersion: number | null = null` is declared at the top of the
  handler's `try`.
- It is set directly after the 400 return for an invalid body
  (`route.ts:153-155`), and before the 426 check at `:190`. A request refused
  with 400 never sets it. A 426 does set it.
- It is set to the validated `protocolVersion`, or to 1 when that field is
  absent. A queued replay whose `protocolVersion` itself is invalid goes on to
  park rather than return 400, so it is excluded explicitly.

The `finally` then writes, next to the response-time metric, only when both
`seenVersion` and `auth.keyFingerprint` are set. The write is fire-and-forget:
a rejected promise is logged and never thrown.

```ts
const protocolVersion = seenVersion;  // already normalized: absent → 1
prisma.kioskProtocolSeen.upsert({
  where: { keyFingerprint },
  create: { keyFingerprint, protocolVersion, lastSeenAt: now },
  update: { protocolVersion, lastSeenAt: now },
})
```

The `where` names only the primary key and there are no nested writes, so
Prisma issues a native `INSERT … ON CONFLICT` on Postgres. Two scans at the
same moment cannot collide on create.

The cost is one single-row upsert per scan, on a route that already writes
the badge log, the visit and a metric row per scan. The write never runs
while the kiosk rests, because a resting kiosk sends no scans. So it cannot
wake the curfewed service or keep the database from pausing.

### 4. Where an operator sees it (KP-VIEW, KP-WHO)

The reading goes in the **Kiosk last seen** box on System Status → Health
(`checkin-app/src/components/admin/SystemHealthPanels.tsx:556`,
`KioskHeartbeatBox`). It shows one line per key fingerprint, with its
protocol version and when it was last seen. A key no longer in
`KIOSK_PUBLIC_KEY` is labelled "key removed".

It is served by the existing `GET /api/system-status/kiosk-heartbeat`
(`checkin-app/src/app/api/system-status/kiosk-heartbeat/route.ts`), which adds
a `KioskProtocolSeen` array to its bag.

**The response shape changes.** The handler unwraps a bag with one key under
the envelope and keeps a bag with several keys as an object
(`checkin-app/src/security/handler.ts:162-164`). Today the bag holds only
`SystemMetricLog`, so the response is `{ heartbeat: [rows] }`. With two keys
it becomes `{ heartbeat: { SystemMetricLog: [rows], KioskProtocolSeen: [rows] } }`.
`KioskHeartbeatBox` reads `data.heartbeat` as an array
(`SystemHealthPanels.tsx:558-559`), and it is the route's only consumer. So
PR 3 changes the route and the box together, and the box reads both arrays
by name. The two cannot ship apart.

Boundary entry, changed in its own registry PR before the route PR:

- `checkin-app/src/security/registry.ts:875`, the `defineRoute` for
  `GET /api/system-status/kiosk-heartbeat`. `returns` becomes
  `['SystemMetricLog', 'KioskProtocolSeen']`. `authorize` and `orderedView`
  are unchanged: sysadmin and Board, `everyones:internal`. The entry's
  comment is updated to say the route also returns stored rows.

No other route or view changes.

### 5. How this tells the kiosk owner when old code can go

Each legacy branch is gated on a version threshold
(`checkin-app/src/lib/scanProtocol.ts`):

| Below | Branch in `checkin-app/src/app/api/scan/route.ts` |
|---|---|
| 3 | the server's own three-second repeat-read check (`:352-353`) |
| 5 | late, out-of-order or doubtful-clock replays are held instead of applied (`:355-356`) |
| 6 | a keyholder's check-out decides the close (`:197`, `LegacyKiosk`) |

A branch gated below version N can be deleted when both hold for every key
still in `KIOSK_PUBLIC_KEY`:

1. Its row's current version is N or above. Kiosks do not move back to an
   older build, so once a kiosk reaches N it stays there.
2. Its last-seen time is recent. A current version on a row that has not been
   seen for weeks describes a kiosk that may since have been rebuilt or
   replaced. The kiosk owner picks what counts as recent.

A configured key with no row has never scanned since recording began. Its
version is unknown, so it blocks deletion until it scans or the key is
removed.

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
   migration, wrapped in `BEGIN;`/`COMMIT;`; the regenerated classifications
   (additions only); the matching key and fingerprint through
   `verify-kiosk.ts`, `auth.ts` and `types/auth.ts`; the guarded upsert in
   the scan route. Tests cover:
   - the fingerprint;
   - an absent version recorded as 1;
   - a 400 not recorded;
   - a 426 recorded;
   - a scan that still succeeds when the upsert rejects.

   No boundary file changes.
2. **Registry entry.** Boundary PR. The `returns` change in
   `checkin-app/src/security/registry.ts` (§4) and its security test, and
   nothing else.
3. **Show it.** Route and UI PR, one PR because the response shape changes
   (§4). The heartbeat route reads the table and returns both arrays.
   `KioskHeartbeatBox` reads them by name and renders the kiosk rows. Its
   tests move to the new shape.

The registry PR comes before the route PR but cannot come before PR 1.
`returns` is typed against the models in the generated classifications
(`checkin-app/src/security/core.ts:329`). A registry entry naming
`KioskProtocolSeen` does not compile until the model exists on `main`. PR 1
writes the row but exposes nothing, so nothing leaves the server before the
registry PR lands.

## Alternatives considered

- **Keep it in process memory, like the heartbeat.** It would be lost every
  night when the service scales to zero, and after every deploy. The kiosk
  owner's question spans weeks.
- **Rows in `SystemMetricLog`.** The 30-day purge erases the evidence. The
  table also has no column for the kiosk.
- **One row per kiosk and version, with first-seen.** It would keep when each
  older version was last seen. Kiosks do not move back to older builds, so
  the current version answers the same question.
- **Write only when the version changes.** Fewer writes, but it needs a
  per-task cache, and last-seen would go stale.
- **Synthesized `SystemMetricLog` rows on the heartbeat route.** This would
  need no boundary PR, but the registry would name the wrong source model.
- **Log lines only.** A log could answer the question, but only by hand
  through CloudWatch, with nothing on System Status.

## Related

- Finding PR2892-F01 (audit item C124a) asked for this record.
- Open PR #2375 reports the kiosk's *build* (release and file digest) in an
  unsigned header, held in memory. That shows what software a kiosk runs. This
  design records the signed protocol version that decides which server
  branches run. The two do not overlap, and this design does not depend on
  #2375.
