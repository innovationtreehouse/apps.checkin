import prisma from "@/lib/prisma";

/**
 * Detection (read-only) of duplicate / overlapping attendance Visit rows.
 *
 * Duplicates arise across write paths rather than within one: a staff insert at
 * a past time, a lead's Present correction, and a live kiosk scan each write a
 * Visit for the same person, and nothing rejects two that merely overlap — the
 * one-open-visit index only stops two OPEN ones.
 *
 * This module ONLY surfaces those overlaps so a lead can resolve them by hand.
 * It adds no constraint, lock, or write-path change (a prevention layer was
 * considered and rejected as disproportionate — severity is an inflated event
 * present-count, which is reversible and human-visible).
 *
 * A Visit interval is half-open: [arrivedAt, departedAt). departedAt = null is an
 * OPEN visit, treated as [arrivedAt, +infinity). Intervals that merely touch at a
 * boundary (one ends exactly when the next begins) do NOT overlap — that's a
 * legitimate back-to-back visit. Disjoint intervals (leave and come back) are
 * also legitimate and never flagged.
 */

export type Interval = { arrivedAt: Date; departedAt: Date | null };

/**
 * True iff two half-open intervals overlap. null departedAt = +infinity.
 * Boundary-touching ([10,20) vs [20,30)) is NOT an overlap.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  const aStartsBeforeBEnds = b.departedAt === null || a.arrivedAt < b.departedAt;
  const bStartsBeforeAEnds = a.departedAt === null || b.arrivedAt < a.departedAt;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/**
 * Group a single participant's visits into overlap-connected clusters of size ≥2.
 * Sweep by arrivedAt, extending a running cluster while the next visit starts
 * before the cluster's max end (null end = +infinity, swallows everything after).
 * Transitive: A∩B, B∩C with A,C disjoint still forms one cluster, which is what a
 * human resolving the pile-up wants to see together.
 *
 * ponytail: O(n log n) sweep; a participant has a handful of visits, never enough
 * to matter.
 */
export function clusterOverlapping<T extends Interval>(visits: T[]): T[][] {
  const sorted = [...visits].sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
  const clusters: T[][] = [];
  let current: T[] = [];
  let maxEnd: Date | null = null; // null = +infinity (an open visit in the cluster)

  for (const v of sorted) {
    if (current.length === 0) {
      current = [v];
      maxEnd = v.departedAt;
      continue;
    }
    const overlaps = maxEnd === null || v.arrivedAt < maxEnd;
    if (overlaps) {
      current.push(v);
      if (maxEnd !== null) {
        if (v.departedAt === null) maxEnd = null;
        else if (v.departedAt > maxEnd) maxEnd = v.departedAt;
      }
    } else {
      if (current.length >= 2) clusters.push(current);
      current = [v];
      maxEnd = v.departedAt;
    }
  }
  if (current.length >= 2) clusters.push(current);
  return clusters;
}

export type ConflictVisit = {
  id: number;
  arrivedAt: string; // ISO
  departedAt: string | null;
  arrivedVia: string | null;
  departedVia: string | null;
  associatedEventId: number | null;
};

export type AttendanceConflict = {
  participantId: number;
  participantName: string;
  /** The led-program event the overlap is anchored to (what makes it this lead's concern). */
  eventId: number;
  eventName: string;
  visits: ConflictVisit[];
};

/**
 * Overlapping-visit conflicts for the programs a lead runs. Scoped to events the
 * caller leads (program.leadMentorId === userId); returns [] for non-leads, so
 * the GET route can hand any signed-in user to it without leaking PII.
 *
 * A cluster is reported only if ≥1 of its visits is anchored to one of the lead's
 * own events — that both scopes the result to their concern and authorizes
 * showing the (possibly unassociated kiosk) sibling visit alongside it.
 */
export async function getLeadConflicts(userId: number): Promise<AttendanceConflict[]> {
  const ledEvents = await prisma.event.findMany({
    where: { program: { leadMentorId: userId } },
    select: { id: true, name: true },
  });
  if (ledEvents.length === 0) return [];
  const ledEventName = new Map(ledEvents.map((e) => [e.id, e.name]));

  // Only participants with at least one visit anchored to a led event can have a
  // conflict in this lead's scope — fetch their full visit set, then cluster.
  const anchored = await prisma.visit.findMany({
    where: { associatedEventId: { in: [...ledEventName.keys()] }, deletedAt: null },
    select: { personId: true },
  });
  const participantIds = [...new Set(anchored.map((v) => v.personId))];
  if (participantIds.length === 0) return [];

  const visits = await prisma.visit.findMany({
    where: { personId: { in: participantIds }, deletedAt: null },
    select: {
      id: true,
      personId: true,
      arrivedAt: true,
      departedAt: true,
      arrivedVia: true,
      departedVia: true,
      associatedEventId: true,
      person: { select: { name: true } },
    },
    orderBy: { arrivedAt: "asc" },
  });

  const byParticipant = new Map<number, typeof visits>();
  for (const v of visits) {
    const list = byParticipant.get(v.personId) ?? [];
    list.push(v);
    byParticipant.set(v.personId, list);
  }

  const conflicts: AttendanceConflict[] = [];
  for (const [participantId, pVisits] of byParticipant) {
    for (const cluster of clusterOverlapping(pVisits)) {
      const anchor = cluster.find((v) => v.associatedEventId !== null && ledEventName.has(v.associatedEventId));
      if (!anchor) continue; // overlap exists but not in this lead's scope
      conflicts.push({
        participantId,
        participantName: pVisits[0].person.name ?? `Participant ${participantId}`,
        eventId: anchor.associatedEventId!,
        eventName: ledEventName.get(anchor.associatedEventId!) ?? `Event ${anchor.associatedEventId}`,
        visits: cluster.map((v) => ({
          id: v.id,
          arrivedAt: v.arrivedAt.toISOString(),
          departedAt: v.departedAt ? v.departedAt.toISOString() : null,
          arrivedVia: v.arrivedVia,
          departedVia: v.departedVia,
          associatedEventId: v.associatedEventId,
        })),
      });
    }
  }
  return conflicts;
}
