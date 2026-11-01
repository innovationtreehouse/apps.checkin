"use client";
import { createClient, lastPage, useViewer } from "@checkin/component-ui";

export { lastPage } from "@checkin/component-ui";

/**
 * Shared client fetch helpers. All catalog reads/writes go
 * through checkin's human surface under /api/catalog/*; the route handlers gate
 * server-side, so the client only decorates the UI with the caller's role.
 */
const BASE = "/api/catalog";

export const { api, useLoad } = createClient(BASE);

/** The page to show: archiving the only row on the last page shrinks the list under the person. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(page, lastPage(total, pageSize));
}

/** Whether the viewer may curate the catalog (write). Mirrors the routes' INVENTORY_MANAGER gate. */
export function useCanManage(): boolean {
  return useViewer()?.isInventoryManager === true;
}
