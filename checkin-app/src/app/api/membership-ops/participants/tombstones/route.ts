import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";
import { RESIDUE_COUNT_KEYS } from "@/lib/person/tombstoneResidue";

export const dynamic = "force-dynamic";

// GET /api/membership-ops/participants/tombstones — the #1456 §2a census.
//
// Lists every tombstone (a merged-away Person, hence the deliberate
// `mergedIntoId: { not: null }` — the one place that inverts LIVE_PERSON) with its
// survivor and a _count of the residue still parked on it. The stripper drops any
// non-model bag key, so the page derives the residue report (disposition per
// relation, no-pathway totals) client-side from the counts; PersonMerge.fromId
// rides along so it can flag a legacy tombstone that has no archive row and would
// strand a badge scan on delete. Field visibility (email is pii, the rest public)
// is governed by the registry. Deleted with LIVE_PERSON in the final teardown.

const COUNT_SELECT = Object.fromEntries(
  RESIDUE_COUNT_KEYS.map((k) => [k, true]),
) as Record<string, true>;

export const GET = handler(
  "GET /api/membership-ops/participants/tombstones",
  async () => {
    const tombstones = await prisma.person.findMany({
      where: { mergedIntoId: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        mergedInto: { select: { id: true, name: true } },
        _count: { select: COUNT_SELECT },
      },
      orderBy: { id: "asc" },
    });

    const archive = await prisma.personMerge.findMany({
      where: { fromId: { in: tombstones.map((t) => t.id) } },
      select: { fromId: true },
    });

    return { Person: tombstones, PersonMerge: archive };
  },
);
