"use client";
import { createClient, notifyNavCounts, useViewer } from "@checkin/component-ui";

export { lastPage } from "@checkin/component-ui";

/**
 * Shared client fetch helpers. All catalog reads/writes go
 * through checkin's human surface under /api/catalog/*; the route handlers gate
 * server-side, so the client only decorates the UI with the caller's role.
 */
const BASE = "/api/catalog";

const client = createClient(BASE);

export const { useLoad } = client;

/** Sends a request; a successful write tells the host nav to refetch its pills. */
export async function api<T>(path: string, options: Parameters<typeof client.api>[1] = {}): Promise<T> {
  const answer = await client.api<T>(path, options);
  if (options.method && options.method !== "GET") notifyNavCounts();
  return answer;
}

/** Whether the viewer may curate the catalog (write). Mirrors the routes' INVENTORY_MANAGER gate. */
export function useCanManage(): boolean {
  return useViewer()?.isInventoryManager === true;
}
