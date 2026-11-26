# Background checks

How background checks and their records work: where a clearance is stored, what
records it leaves, and how those records survive changes to the person they
describe. The terms used here (review, attest, clearance) are defined in
[VOCABULARY.md](../VOCABULARY.md#background-check). This file starts with one
note and grows as more of the area is written down.

---

## How a clearance is recorded

A clearance shows in two fields: the person's check date,
`Person.lastBackgroundCheck` (a bare date), and an application's `bgClearedAt`.
Different paths write them, and each leaves a different audit row.

**A person's check review clears.** A check review is a `PERSON_BG` application
(`OrgMembershipProcess`). Its second approving attestation runs
`clearBackgroundCheck` in `checkin-app/src/lib/membership/review.ts`, which
writes three things in one transaction:

- `Person.lastBackgroundCheck` on the subject;
- `bgClearedAt` on the application;
- an `AuditLog` row on the application (`tableName` `OrgMembershipProcess`,
  `affectedEntityId` the application's id), whose `newData` carries
  `bgCleared: true` and the `subjectPersonId` it cleared.

This is the only path that writes a check date from a check.

**A household application qualifies on its people's checks.** An `INITIAL` or
`RENEWAL` application clears when its people's check dates already qualify; this
is how a renewal clears on a still-valid prior check. The household settle in
`checkin-app/src/lib/membership/settleHouseholdBg.ts` stamps `bgClearedAt` on the
application and writes nothing on any `Person`. Its audit row is on the
application too (`tableName` `OrgMembershipProcess`, `affectedEntityId` the
application's id, `secondaryAffectedEntity` the household's id), written by
`system:membership-bg-settle`. Its `newData` carries `bgCleared: true` and a
`reason` instead of a `subjectPersonId`, plus the settle's `trigger` when it had
one; a settle after a merge records `{ kind: "merge", personMergeId }`. The
settle runs after intake, the start of a renewal, a check review, a payment, a
merge and other membership events. Its row says which application cleared, not
whose check it relied on: that is the household's people's check dates, each
written by one of the other paths here.

**A person merge carries a date.** A merge sets the survivor's
`lastBackgroundCheck` to the newer of the two records' dates, and writes no
clearance audit row. The next section traces such a date.

**Dev fixtures.** On a dev or local instance, the seed and the dev dashboard's
macros (`checkin-app/src/lib/dev/seed-helpers.ts`) set `lastBackgroundCheck`
directly, with no clearance audit row.

## Where a merged check date came from

When a person merge carries a newer background-check date onto the surviving
record, the record of where that date came from is the application's audit row
together with the person-merge archive. The person record keeps no link back to
the application that cleared the check.

A merge always keeps the newer of the two `lastBackgroundCheck` dates
(`carriedComplianceDate` in `checkin-app/src/lib/person/merge/plan.ts`). The
transaction in `merge/execute.ts` then repoints the merged-away person's
applications to the survivor, writes a `PersonMerge` archive row, and deletes the
merged-away `Person`. So, after the merge:

- the application that cleared the check names the survivor as its subject;
- its clearance audit row still names the merged-away person's id, as it stood
  when the check cleared;
- the `PersonMerge` row maps that id (`fromId`) to the survivor (`toId`), and its
  `snapshot` keeps the merged-away record's own `lastBackgroundCheck`.

To trace a survivor's carried date, look at each `PersonMerge` row with that
survivor as `toId` whose snapshot holds the date. There can be more than one: a
merge repoints earlier `PersonMerge` rows to its survivor (`merge/execute.ts`), so
if A merged into B and then B into C, both rows name C as `toId` and both
snapshots hold A's date. Follow the one whose `fromId` has a clearance audit row,
the row whose `subjectPersonId` is that `fromId`. The Board need not find these
rows by hand: the Compliance page's "Background-check dates inherited from a
merge" list (`mergeInheritedBgChecks` in
`checkin-app/src/app/api/membership-audit/compliance/route.ts`) shows each
survivor whose date matches a merged record's snapshot, and names one such
record. The merge's own audit row (`tableName` `Person`, written when a person
ran the merge) records both records' dates before the merge as well, but it
names no application.
