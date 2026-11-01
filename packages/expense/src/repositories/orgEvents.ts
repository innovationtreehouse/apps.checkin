import type { Db } from "../db";
import type { ExpenseReceivedOrgEvent, ReceivedOrgEventStatus, NewReceivedOrgEvent } from "../db/schema";

export function createOrgEventsRepository(db: Db) {
  return {
    /** Those of `ids` already received (any status). */
    async idsIn(ids: number[]): Promise<number[]> {
      const rows = await db.expenseReceivedOrgEvent.findMany({ where: { id: { in: ids } }, select: { id: true } });
      return rows.map((r) => r.id);
    },

    async findOne(id: number): Promise<ExpenseReceivedOrgEvent | null> {
      return db.expenseReceivedOrgEvent.findFirst({ where: { id } });
    },

    async exists(id: number): Promise<boolean> {
      const row = await db.expenseReceivedOrgEvent.findFirst({ where: { id }, select: { id: true } });
      return row != null;
    },

    async insert(data: NewReceivedOrgEvent) {
      await db.expenseReceivedOrgEvent.create({ data });
    },

    async updateStatus(id: number, status: ReceivedOrgEventStatus, failureReason?: string | null) {
      await db.expenseReceivedOrgEvent.update({
        where: { id },
        data: { status, failureReason: failureReason ?? null },
      });
    },

    async findPending(orgId: string): Promise<ExpenseReceivedOrgEvent[]> {
      return db.expenseReceivedOrgEvent.findMany({
        where: {
          orgId,
          status: { in: ["pending", "failed"] },
        },
        orderBy: { id: "asc" },
      });
    },
  };
}

export type OrgEventsRepository = ReturnType<typeof createOrgEventsRepository>;
