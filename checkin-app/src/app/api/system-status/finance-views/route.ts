import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { handler, badRequest } from "@/security/handler";
import { FINANCE_VIEWS_PAGE_SIZE, financeViewKindWhere, isFinanceViewKind } from "@/lib/finance/financeViewKinds";

/**
 * The Board's finance view log (B11): who viewed which finance records,
 * newest first, a page at a time. Backs the "Finance Views" tab on System
 * status. The bag carries no total, so the page over-fetches one row to
 * signal that another page follows.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string | null, label: string, time: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(`${value}T${time}`);
    if (!DAY.test(value) || isNaN(d.getTime())) throw badRequest(`Invalid ${label} date.`);
    return d;
}

export const GET = handler('GET /api/system-status/finance-views', async ({ req }) => {
    const sp = new URL(req.url).searchParams;

    const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1);
    const filters: Prisma.FinanceViewLogWhereInput[] = [];

    const person = sp.get('person');
    if (person) {
        const actorId = Number(person);
        if (!Number.isInteger(actorId) || actorId <= 0) throw badRequest('Invalid person.');
        filters.push({ actorId });
    }

    const kind = sp.get('kind');
    if (kind) {
        if (!isFinanceViewKind(kind)) throw badRequest('Invalid record kind.');
        filters.push(financeViewKindWhere(kind));
    }

    // `has` compiles to array containment, which the GIN index on recordIds serves.
    const record = sp.get('record')?.trim();
    if (record) filters.push({ recordIds: { has: record } });

    // from/to are yyyy-mm-dd, an inclusive day range in server time, as on the Audit Log tab.
    const from = parseDay(sp.get('from'), 'from', '00:00:00.000');
    const to = parseDay(sp.get('to'), 'to', '23:59:59.999');
    if (from || to) filters.push({ viewedAt: { gte: from, lte: to } });

    const [rows, actors] = await Promise.all([
        prisma.financeViewLog.findMany({
            where: { AND: filters },
            orderBy: [{ viewedAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * FINANCE_VIEWS_PAGE_SIZE,
            take: FINANCE_VIEWS_PAGE_SIZE + 1,
        }),
        // Every viewer in the log, for the person filter as well as this page's names.
        prisma.financeViewLog.groupBy({ by: ['actorId'] }),
    ]);

    // Not LIVE_PERSON-filtered: a viewer since merged away must still be named.
    const people = actors.length
        ? await prisma.person.findMany({
            where: { id: { in: actors.map((a) => a.actorId) } },
            select: { id: true, name: true },
        })
        : [];

    // Always both keys, even empty: handler.ts unwraps a single-key bag to a bare value.
    return { FinanceViewLog: rows, Person: people };
});
