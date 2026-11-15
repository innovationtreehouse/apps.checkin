import prisma from "@/lib/prisma";
import { handler, badRequest } from "@/security/handler";
import { archivedPeople } from "@/lib/person/archivedPeople";
import { parseDayAt } from "@/lib/time";
import { FINANCE_VIEWS_PAGE_SIZE, isFinanceViewModel, parseFinanceViewCursor } from "@/lib/finance/financeViewKinds";
import { financeViewsPageQuery, type FinanceViewsFilter } from "@/lib/finance/financeViewsPage";

/**
 * The Board's finance view log (B11): who viewed which finance records,
 * newest first, a page at a time. Backs the "Finance Views" tab on System
 * status. `before` (`<viewedAt epoch ms>_<id>`) starts a page after the row it
 * names. The bag carries no total, so the page over-fetches one row to signal
 * that an older page follows.
 */

function parseDay(value: string | null, label: string, time: string): Date | undefined {
    if (!value) return undefined;
    const d = parseDayAt(value, time);
    if (!d) throw badRequest(`Invalid ${label} date.`);
    return d;
}

export const GET = handler('GET /api/system-status/finance-views', async ({ req }) => {
    const sp = new URL(req.url).searchParams;

    const filter: FinanceViewsFilter = {};

    const person = sp.get('person');
    if (person) {
        const actorId = Number(person);
        if (!Number.isInteger(actorId) || actorId <= 0) throw badRequest('Invalid person.');
        filter.actorId = actorId;
    }

    const kind = sp.get('kind');
    if (kind) {
        if (!isFinanceViewModel(kind)) throw badRequest('Invalid record type.');
        filter.model = kind;
    }

    const record = sp.get('record')?.trim();
    if (record) filter.record = record;

    // from/to are yyyy-mm-dd, an inclusive day range in server time, as on the Audit Log tab.
    filter.from = parseDay(sp.get('from'), 'from', '00:00:00.000');
    filter.to = parseDay(sp.get('to'), 'to', '23:59:59.999');

    const before = sp.get('before');
    if (before) {
        const cursor = parseFinanceViewCursor(before);
        if (!cursor) throw badRequest('Invalid before marker.');
        filter.before = cursor;
    }

    const [ids, actors] = await Promise.all([
        prisma.$queryRaw<{ id: number }[]>(financeViewsPageQuery(filter, FINANCE_VIEWS_PAGE_SIZE + 1)),
        // Every viewer in the log, for the person filter as well as this page's names.
        prisma.financeViewLog.groupBy({ by: ['actorId'] }),
    ]);
    const rows = ids.length
        ? await prisma.financeViewLog.findMany({
            where: { id: { in: ids.map((r) => r.id) } },
            select: { id: true, viewedAt: true, actorId: true, role: true, endpoint: true, recordIds: true, pagePath: true, calls: true, records: true },
            orderBy: [{ viewedAt: 'desc' }, { id: 'desc' }],
        })
        : [];

    // A viewer since merged away has no Person row; they are named from the merge archive.
    const actorIds = actors.map((a) => a.actorId);
    const people: { id: number; name: string | null }[] = actors.length
        ? await prisma.person.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true },
        })
        : [];
    const found = new Set(people.map((p) => p.id));
    for (const { id, name } of await archivedPeople(prisma, actorIds.filter((id) => !found.has(id)))) {
        people.push({ id, name });
    }

    // Always both keys, even empty: handler.ts unwraps a single-key bag to a bare value.
    return { FinanceViewLog: rows, Person: people };
});
