import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";
import { ordersByLegacyIds, type MirrorOrder } from "@/lib/shopifyRead/client";
import { LIVE_PERSON } from "@/lib/person/filters";
import { archivedPeople } from "@/lib/person/archivedPeople";

/**
 * GET /api/finance-ops/payments — the board's queue of reconciler-detected
 * payment problems (PaymentException) still needing action: OPEN or ACKNOWLEDGED,
 * CRITICAL before WARN, newest first.
 *
 * Live order amounts are NOT stored on the row (they drift): we re-read them from
 * the s-read mirror by shopifyOrderId. A mirror-less env (unconfigured) just
 * yields no live block — the row still lists. See lib/shopifyRead/client.ts.
 */
export const GET = handler(
    "GET /api/finance-ops/payments",
    async () => {
        const exceptions = await prisma.paymentException.findMany({
            where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
            orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }], // CRITICAL(1) before WARN(0), newest first
        });

        // Batch the display-context lookups: households (via process), people, and
        // programs — one query each, keyed back onto the rows below.
        const processIds = [...new Set(exceptions.map((e) => e.processId).filter((v): v is number => v !== null))];
        const personIds = [...new Set(exceptions.map((e) => e.personId).filter((v): v is number => v !== null))];
        const programIds = [...new Set(exceptions.map((e) => e.programId).filter((v): v is number => v !== null))];
        const orderIds = [...new Set(exceptions.map((e) => e.shopifyOrderId).filter((v): v is string => v !== null))];

        const [processes, persons, programs, orders] = await Promise.all([
            processIds.length
                ? prisma.orgMembershipProcess.findMany({
                      where: { id: { in: processIds } },
                      select: {
                          id: true,
                          orgMembership: {
                              select: {
                                  household: {
                                      select: {
                                          name: true,
                                          // The household lead carries the contact email shown in the queue.
                                          householdMembers: {
                                              where: { isHouseholdLead: true, ...LIVE_PERSON },
                                              select: { name: true, email: true },
                                              take: 1,
                                          },
                                      },
                                  },
                              },
                          },
                      },
                  })
                : Promise.resolve([]),
            personIds.length
                ? prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true, email: true } })
                : Promise.resolve([]),
            programIds.length
                ? prisma.program.findMany({ where: { id: { in: programIds } }, select: { id: true, name: true } })
                : Promise.resolve([]),
            // Mirror read is best-effort: an unconfigured env returns [], and a
            // transient mirror error must not take the whole queue down.
            hydrateOrders(orderIds),
        ]);

        const procMap = new Map(processes.map((p) => [p.id, p]));
        // A merged-away payer keeps their name; the address to chase falls to the household lead.
        const personMap = new Map<number, { name: string | null; email?: string | null }>(persons.map((p) => [p.id, p]));
        for (const archived of await archivedPeople(prisma, personIds.filter((id) => !personMap.has(id)))) {
            personMap.set(archived.id, { name: archived.name });
        }
        const programMap = new Map(programs.map((p) => [p.id, p]));
        const orderMap = new Map(orders.filter((o) => o.legacyId !== null).map((o) => [o.legacyId as string, o]));

        const rows = exceptions.map((e) => {
            const proc = e.processId !== null ? procMap.get(e.processId) : undefined;
            const household = proc?.orgMembership?.household;
            const lead = household?.householdMembers[0];
            const person = e.personId !== null ? personMap.get(e.personId) : undefined;
            const program = e.programId !== null ? programMap.get(e.programId) : undefined;
            const order = e.shopifyOrderId !== null ? orderMap.get(e.shopifyOrderId) : undefined;

            return {
                id: e.id,
                kind: e.kind,
                severity: e.severity,
                status: e.status,
                shopifyOrderId: e.shopifyOrderId,
                processId: e.processId,
                programId: e.programId,
                personId: e.personId,
                detectedAt: e.detectedAt,
                familyName: person?.name ?? household?.name ?? null,
                familyEmail: person?.email ?? lead?.email ?? null,
                programName: program?.name ?? null,
                live: order
                    ? {
                          financialStatus: order.financialStatus,
                          totalCents: order.totalCents,
                          totalRefundedCents: order.totalRefundedCents,
                          cancelledAt: order.cancelledAt,
                      }
                    : null,
            };
        });

        return { PaymentQueueRow: rows };
    }
);

/** Best-effort live-amount lookup; never throws (mirror unconfigured or down → []). */
async function hydrateOrders(orderIds: string[]): Promise<MirrorOrder[]> {
    if (orderIds.length === 0) return [];
    try {
        return await ordersByLegacyIds(orderIds);
    } catch (error) {
        logger.error("Failed to hydrate payment-exception order amounts:", error);
        return [];
    }
}
