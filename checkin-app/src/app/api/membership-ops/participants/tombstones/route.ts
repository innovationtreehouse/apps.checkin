import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";

export const dynamic = 'force-dynamic';

// #1456 §2a census. A merged-away Person is a tombstone: the merge repoints its
// live rows to the survivor and parks only what a unique-constraint collision
// left behind. 2b-3 will delete the tombstone row, but a delete is only safe once
// its residue is resolved — and there is no other surface that shows it. This
// route reads tombstones deliberately (hence `mergedIntoId: { not: null }`, the
// one place that inverts the LIVE_PERSON filter) and, per parked relation, says
// whether a self-serve cleanup pathway exists. Deleted with LIVE_PERSON in 2b-4.

type Disposition = 'route' | 'cascade' | 'none';

// Every Person back-relation that can hold a row after a merge, with how a human
// resolves it before the tombstone can be deleted:
//   route   — a verified self-serve DELETE exists (hint names it).
//   cascade — the FK is onDelete: Cascade, so the row is silently removed WITH
//             the tombstone. Flagged because that is data loss, not resolution.
//   none    — no self-serve route; must be resolved in the DB (or a route built).
// `route` entries are the only ones whose verb was confirmed present; when in
// doubt an entry is `none` — under-claiming a pathway is safe, inventing one is not.
const RESIDUE_RELATIONS: ReadonlyArray<{
  key: string;
  label: string;
  disposition: Disposition;
  hint?: string;
}> = [
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
] as const;

const COUNT_SELECT = Object.fromEntries(
  RESIDUE_RELATIONS.map((r) => [r.key, true]),
) as Record<string, true>;

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

export const GET = withAuth(
  { roles: ['isSysadmin', 'isBoardMember'] },
  async () => {
    try {
      const tombstones = await prisma.person.findMany({
        where: { mergedIntoId: { not: null } },
        select: {
          id: true,
          name: true,
          email: true,
          mergedInto: { select: { id: true, name: true } },
          _count: { select: COUNT_SELECT },
        },
        orderBy: { id: 'asc' },
      });

      // A legacy tombstone (merged before #1729) has no PersonMerge row, so
      // deleting it would strand any badge that still encodes its id — the scan
      // path resolves a gone row through PersonMerge only. Surface that gap.
      const archived = await prisma.personMerge.findMany({
        where: { fromId: { in: tombstones.map((t) => t.id) } },
        select: { fromId: true },
      });
      const archivedIds = new Set(archived.map((a) => a.fromId));

      const rows = tombstones.map((t) => {
        const { residue, noPathwayRows } = summarizeResidue(
          t._count as unknown as Record<string, number>,
        );
        return {
          id: t.id,
          name: t.name,
          email: t.email,
          survivorId: t.mergedInto?.id ?? null,
          survivorName: t.mergedInto?.name ?? null,
          hasArchive: archivedIds.has(t.id),
          residue,
          noPathwayRows,
        };
      });

      return NextResponse.json({
        tombstones: rows,
        totals: {
          tombstones: rows.length,
          withResidue: rows.filter((r) => r.residue.length > 0).length,
          withoutArchive: rows.filter((r) => !r.hasArchive).length,
          noPathwayRows: rows.reduce((sum, r) => sum + r.noPathwayRows, 0),
        },
      });
    } catch (err) {
      logger.error({ err }, 'tombstone census failed');
      return apiError('Failed to load tombstone census.', 500);
    }
  },
);
