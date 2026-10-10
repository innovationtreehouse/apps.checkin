import type { Db } from "../db";
import type { ExpenseReceivedOrgEvent, ReceivedOrgEventStatus, NewReceivedOrgEvent } from "../db/schema";

export function createOrgEventsRepository(db: Db) {
  return {
    async getMaxId(): Promise<number> {
      const result = await db.expenseReceivedOrgEvent.aggregate({ _max: { id: true } });
      return result._max.id ?? 0;
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
