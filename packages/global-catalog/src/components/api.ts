"use client";
import { createClient, useViewer } from "@checkin/component-ui";

export { errorMessage, lastPage } from "@checkin/component-ui";

/**
 * Shared client fetch helper. All catalog reads/writes go
 * through checkin's human surface under /api/catalog/*; the route handlers gate
 * server-side, so the client only decorates the UI with the caller's role.
 */
const BASE = "/api/catalog";

export const { api } = createClient(BASE);

/**
 * Drops stale responses: each `begin()` starts a request and returns a check
 * that stays true only while no later request has begun.
 */
export function latestGate(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}

/** Whether the viewer may curate the catalog (write). Mirrors the routes' INVENTORY_MANAGER gate. */
export function useCanManage(): boolean {
  return useViewer()?.isInventoryManager === true;
}
