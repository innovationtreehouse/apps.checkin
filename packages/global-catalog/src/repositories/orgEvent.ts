import type { PrismaClient, Prisma } from "../generated/prisma/client";
import type { WorkflowType } from "../db/schema";
import type { OrgEventPayload } from "../types/orgEvents";

type Tx = Prisma.TransactionClient;

export function createOrgEventRepository(db: PrismaClient) {
  return {
    // ── Workflow Transition Log ───────────────────────────────────────────────

    recordTransition: (
      tx: Tx,
      workflowType: WorkflowType,
      recordId: number,
      fromStatus: string,
      toStatus: string,
      transitionedByUserId: number | null,
      note?: string
    ) =>
      tx.workflowTransitionLog.create({
        data: {
          workflowType,
          recordId,
          fromStatus,
          toStatus,
          transitionedByUserId: transitionedByUserId ?? null,
          note: note ?? null,
        },
      }),

    // ── Org Events ────────────────────────────────────────────────────────────

    emitOrgEvent: (tx: Tx, orgId: string, payload: OrgEventPayload) => {
      const { eventType, ...rest } = payload;
      return tx.orgEvent.create({
        data: {
          orgId,
          eventType,
          payload: JSON.stringify(rest),
        },
      });
    },

    listOrgEvents: (orgId: string, after: number) =>
      db.orgEvent.findMany({
        where: { orgId, id: { gt: after } },
        orderBy: { id: "asc" },
        take: 100,
      }),
  };
}

export type OrgEventRepository = ReturnType<typeof createOrgEventRepository>;
