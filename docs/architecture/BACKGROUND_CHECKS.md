# Background checks

How background checks and their records work: where a clearance is stored, what
records it leaves, and how those records survive changes to the person they
describe. The terms used here (review, attest, clearance) are defined in
[VOCABULARY.md](../VOCABULARY.md#background-check). This file starts with one
note and grows as more of the area is written down.

---

## How a clearance is recorded

A clearance is the second approving attestation on a person's check review, a
`PERSON_BG` application (`OrgMembershipProcess`). `clearBackgroundCheck` in
`checkin-app/src/lib/membership/review.ts` writes three things in one
transaction:

- `Person.lastBackgroundCheck` on the subject, a bare date;
- `bgClearedAt` on the application;
- an `AuditLog` row on the application (`tableName` `OrgMembershipProcess`,
  `affectedEntityId` the application's id), whose `newData` carries
  `bgCleared: true` and the `subjectPersonId` it cleared.

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

To trace a survivor's carried date, find the `PersonMerge` row with that survivor
as `toId` whose snapshot holds the date, then the clearance audit row whose
`subjectPersonId` is that row's `fromId`. The merge's own audit row (`tableName`
`Person`, written when a person ran the merge) records both records' dates before
the merge as well, but it names no application.
