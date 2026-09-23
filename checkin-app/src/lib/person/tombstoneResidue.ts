// #1456 §2a census. A merged-away Person is a tombstone: the merge repoints its
// live rows to the survivor and parks only what a unique-constraint collision
// left behind. 2b-3 will delete the tombstone row, but a delete is only safe once
// its residue is resolved. This module classifies that residue by whether a
// self-serve cleanup pathway exists — the "no pathway" report the census produces.
// Shared by the census route (relation list for the _count select) and its page
// (deriving the report client-side from the returned counts). Deleted with
// LIVE_PERSON in the final teardown.

export type Disposition = 'route' | 'cascade' | 'none';

// Every Person back-relation that can hold a row after a merge, with how a human
// resolves it before the tombstone can be deleted:
//   route   — a verified self-serve DELETE exists (hint names it).
//   cascade — the FK is onDelete: Cascade, so the row is silently removed WITH
//             the tombstone. Flagged because that is data loss, not resolution.
//   none    — no self-serve route; must be resolved in the DB (or a route built).
// `route` entries are the only ones whose verb was confirmed present; when in
// doubt an entry is `none` — under-claiming a pathway is safe, inventing one is not.
export interface ResidueRelation {
  key: string;
  label: string;
  disposition: Disposition;
  hint?: string;
}

export const RESIDUE_RELATIONS: ReadonlyArray<ResidueRelation> = [
  { key: 'programParticipants', label: 'Program enrollments', disposition: 'route', hint: 'Unenroll via the program roster' },
  { key: 'programVolunteers', label: 'Program volunteer roles', disposition: 'route', hint: 'Remove via the program volunteers list' },
  { key: 'bgAttestations', label: 'BG attestations (as reviewer)', disposition: 'route', hint: 'Remove via membership-ops → bg-attestations' },
  { key: 'bgAttestationsAsSubject', label: 'BG attestations (as subject)', disposition: 'route', hint: 'Remove via membership-ops → bg-attestations' },
  { key: 'visits', label: 'Visits', disposition: 'route', hint: 'Delete via facility visits / attendance' },
  { key: 'roles', label: 'Role grants', disposition: 'cascade' },
  { key: 'presenceEvents', label: 'Presence events', disposition: 'cascade' },
  { key: 'toolStatuses', label: 'Tool certifications', disposition: 'none' },
  { key: 'rsvps', label: 'Event RSVPs', disposition: 'none' },
  { key: 'corporationLeads', label: 'Corporation leads', disposition: 'none' },
  { key: 'corporationMembers', label: 'Corporation members', disposition: 'none' },
  { key: 'personBgProcesses', label: 'BG processes (as subject)', disposition: 'none' },
  { key: 'rawBadgeLogs', label: 'Raw badge logs', disposition: 'none' },
  { key: 'trustedAdultsDisclosed', label: 'Trusted-adult disclosures', disposition: 'none' },
  // A chained merge: another tombstone still points its mergedIntoId at THIS
  // row (merge/route.ts repoints only the row being merged, never earlier
  // tombstones already pointing at it). No self-serve pathway — the FK must be
  // repointed to the final survivor in the DB before either row can be deleted.
  { key: 'mergedFrom', label: 'Chained tombstones (FK still points here)', disposition: 'none' },
] as const;

// The relation names the census route counts, for its Prisma `_count` select.
export const RESIDUE_COUNT_KEYS: ReadonlyArray<string> = RESIDUE_RELATIONS.map((r) => r.key);

// Given a tombstone's per-relation counts, its parked residue (nonzero only) with
// each row's cleanup disposition, and the number of rows that have no self-serve
// pathway — the "no pathway" report the census exists to produce.
export function summarizeResidue(counts: Record<string, number>) {
  const residue = RESIDUE_RELATIONS
    .map((r) => ({ ...r, count: counts[r.key] ?? 0 }))
    .filter((r) => r.count > 0);
  const noPathwayRows = residue
    .filter((r) => r.disposition === 'none')
    .reduce((sum, r) => sum + r.count, 0);
  return { residue, noPathwayRows };
}
