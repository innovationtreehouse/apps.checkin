/**
 * Read-only ledgers: the inventory log, the applied-delta record, and the
 * received catalog org-events. The two unbounded ones page, newest first, and
 * have a count for the numbered pager.
 */
import { db } from "../lib/db";
import { getOrg } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { pageArgs, query } from "./_shared";

const byOrg = () => ({ orgId: getOrg().id });

export const inventoryLog: InventoryRouteHandler = async ({ req }) => ({
  InventoryLog: await db.inventoryLog.findMany({
    where: byOrg(),
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
    ...pageArgs(query(req)),
  }),
});

export const inventoryLogCount: InventoryRouteHandler = async () => ({
  InventoryCount: { total: await db.inventoryLog.count({ where: byOrg() }) },
});

export const receivedInventoryDeltas: InventoryRouteHandler = async ({ req }) => ({
  ReceivedInventoryDelta: await db.receivedInventoryDelta.findMany({
    where: byOrg(),
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    ...pageArgs(query(req)),
  }),
});

export const receivedInventoryDeltasCount: InventoryRouteHandler = async () => ({
  InventoryCount: { total: await db.receivedInventoryDelta.count({ where: byOrg() }) },
});

export const receivedOrgEvents: InventoryRouteHandler = async () => ({
  InventoryReceivedOrgEvent: await db.inventoryReceivedOrgEvent.findMany({
    where: byOrg(),
    orderBy: { id: "desc" },
  }),
});
