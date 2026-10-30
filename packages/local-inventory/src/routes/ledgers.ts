/**
 * Read-only ledgers: the inventory log, the applied-delta record, and the
 * received catalog org-events. The two unbounded ones page, newest first,
 * filter by the query, and have a count for the numbered pager.
 */
import { query } from "@checkin/component-kit";
import { db } from "../lib/db";
import { getOrgId } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { pageArgs } from "./_shared";

const byOrg = async () => ({ orgId: await getOrgId() });

/** The log narrowed to one receipt's changes by `?receiptId=`. */
export function logFilter(sp: URLSearchParams): { receiptId?: string } {
  const receiptId = sp.get("receiptId");
  return receiptId ? { receiptId } : {};
}

/** The applies narrowed to one outcome by `?status=applied|failed`; any other value is ignored. */
export function deltaFilter(sp: URLSearchParams): { status?: "applied" | "failed" } {
  const status = sp.get("status");
  return status === "applied" || status === "failed" ? { status } : {};
}

export const inventoryLog: InventoryRouteHandler = async ({ req }) => ({
  InventoryLog: await db.inventoryLog.findMany({
    where: { ...(await byOrg()), ...logFilter(query(req)) },
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
    ...pageArgs(query(req)),
  }),
});

export const inventoryLogCount: InventoryRouteHandler = async ({ req }) => ({
  InventoryCount: { total: await db.inventoryLog.count({ where: { ...(await byOrg()), ...logFilter(query(req)) } }) },
});

export const receivedInventoryDeltas: InventoryRouteHandler = async ({ req }) => ({
  ReceivedInventoryDelta: await db.receivedInventoryDelta.findMany({
    where: { ...(await byOrg()), ...deltaFilter(query(req)) },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    ...pageArgs(query(req)),
  }),
});

export const receivedInventoryDeltasCount: InventoryRouteHandler = async ({ req }) => ({
  InventoryCount: { total: await db.receivedInventoryDelta.count({ where: { ...(await byOrg()), ...deltaFilter(query(req)) } }) },
});

export const receivedOrgEvents: InventoryRouteHandler = async () => ({
  InventoryReceivedOrgEvent: await db.inventoryReceivedOrgEvent.findMany({
    where: await byOrg(),
    orderBy: { id: "desc" },
  }),
});
