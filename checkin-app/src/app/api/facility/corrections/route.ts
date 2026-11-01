import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { handler, badRequest } from "@/security/handler";
import { getAppSettings } from "@/lib/appSettings";
import { getPeriodStart, type PeriodType } from "@/lib/timePeriods";
import { MAX_ROWS } from "@/lib/corrections";
import { SYSTEM_ACTOR } from "@/lib/auditActor";
import { archivedPeople } from "@/lib/person/archivedPeople";

/**
 * Board/sysadmin review of attendance corrections. Reads the
 * AuditLog trail for tableName='Visit' — nothing new is stored.
 * Governing rules: docs/rules/attendance-checkin.md, "The visit record".
 *
 * The bag is SYNTHESIZED, not passed through:
 * `oldData`/`newData` are internal-tier JSON blobs that carry personal-tier
 * Visit times inside them, and the stripper cannot see through JSON. So this
 * handler reads the blobs and rebuilds each bag entry from named fields —
 * the raw blobs never leave this file. `kind`/`actorClass` are NOT computed
 * here: they fall out client-side from action/actorId/secondaryAffectedEntity,
 * which do ship.
 */

const PERIODS: readonly PeriodType[] = ["week", "month", "quarter", "year"];

// Visit fields the before/after picks are allowed to carry, explicitly listed
// — never a spread. The raw blobs also carry participantId/synthetic/status/
// reason/type, none of which are Visit columns.
const VISIT_FIELDS = [
    "id", "personId", "arrivedAt", "departedAt", "arrivedVia", "departedVia", "associatedEventId",
] as const;

function asObject(blob: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null;
    return blob as Record<string, unknown>;
}

function pickVisit(blob: Prisma.JsonValue | null): Record<string, unknown> | null {
    const obj = asObject(blob);
    if (!obj) return null;
    const picked: Record<string, unknown> = {};
    for (const f of VISIT_FIELDS) {
        if (f in obj) picked[f] = obj[f];
    }
    return picked;
}

function parseDate(value: string | null, label: string): Date | null {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) throw badRequest(`Invalid ${label} date.`);
    return d;
}

export const GET = handler('GET /api/facility/corrections', async ({ req }) => {
    const sp = new URL(req.url).searchParams;

    const periodParam = sp.get('period') || 'month';
    if (!PERIODS.includes(periodParam as PeriodType)) {
        throw badRequest('Invalid period. Use week, month, quarter, or year.');
    }
    const period = periodParam as PeriodType;

    const { timezone } = await getAppSettings();

    const to = parseDate(sp.get('to'), 'to') ?? new Date();
    const from = parseDate(sp.get('from'), 'from') ?? getPeriodStart(to, period, timezone);
    const flaggedOnly = sp.get('flagged') === 'true';

    const where: Prisma.AuditLogWhereInput = {
        tableName: 'Visit', // pinned — never taken from the request; a generic
                             // audit browser by table already exists (/system-status/audit-log)
        timestamp: { gte: from, lte: to },
        ...(flaggedOnly ? { newData: { path: ['significance', 'flagged'], equals: true } } : {}),
    };

    const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: MAX_ROWS + 1,
    });

    // Any future filtering (kind, actor class) happens on `rows`, above this
    // line — both maps below walk the same array with nothing between them,
    // so AuditLog[i] and Visit[i] always describe the same audit row.

    const auditLog = rows.map((r) => {
        const newData = asObject(r.newData) ?? {};
        return {
            id: r.id,
            timestamp: r.timestamp,
            actorId: r.actorId,
            actorSystem: r.actorSystem,
            action: r.action,
            tableName: r.tableName,
            affectedEntityId: r.affectedEntityId,
            secondaryAffectedEntity: r.secondaryAffectedEntity,
            // Rebuilt, not copied: these three named fields only. oldData never
            // rides at all — the before-state ships solely via the Visit pair below.
            newData: { type: newData.type, significance: newData.significance, overlapsVisitIds: newData.overlapsVisitIds },
        };
    });

    // [before, after] pairs — `before` exists only inside oldData (no fetchable
    // row), so it can't be a separate Visit array keyed by id; a nested pair is
    // the only shape that keeps AuditLog[i] and Visit[i] aligned by index.
    // ponytail: these synthesized rows can carry a null personId (secondaryAffectedEntity
    // is Int?). Safe today — Visit has no entry in ROW_SCOPE_KEY, so scopesHeld()
    // seeds `everyones` unconditionally — but scopesHeld() fails CLOSED (drops
    // `everyones` too) for any model that DOES have one whose key field is missing.
    // If Visit is ever row-scoped there, these entries would silently strip to {}.
    const visitPairs = rows.map((r) => [pickVisit(r.oldData), pickVisit(r.newData)]);

    // Actor + subject names, batched — AuditLog has no @relation to Person.
    // mergedIntoId rides along so the drill-down can follow a since-merged
    // subject to their surviving record: a merge moves the visits, so an older
    // audit row can name a person since merged away. A merge deletes the
    // Person row, so that person comes from the merge archive instead.
    // SYSTEM_ACTOR is a sentinel, not a person id — looking it up would find
    // nobody and the row would render as one person editing another's record.
    const personIds = new Set<number>();
    for (const r of rows) {
        if (r.actorId !== SYSTEM_ACTOR) personIds.add(r.actorId);
        if (r.secondaryAffectedEntity != null) personIds.add(r.secondaryAffectedEntity);
    }
    // Deliberately NOT LIVE_PERSON-filtered: an audit row's actor or subject may
    // since have been merged away, and the drill-down must still name them.
    // `mergedIntoId` is selected so the UI can mark the row, and because the
    // drift guard reads its presence as the filter — keep it if the select narrows.
    const people: { id: number; name: string | null; mergedIntoId: number | null }[] = personIds.size
        ? await prisma.person.findMany({
            where: { id: { in: [...personIds] } },
            select: { id: true, name: true, mergedIntoId: true },
        })
        : [];
    const found = new Set(people.map((p) => p.id));
    people.push(...await archivedPeople(prisma, [...personIds].filter((id) => !found.has(id))));

    // Always all three keys, even empty — handler.ts unwraps a single-key bag
    // to a bare value, which would turn an empty result into a bare `[]`.
    return { AuditLog: auditLog, Person: people, Visit: visitPairs };
});
