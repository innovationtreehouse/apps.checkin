"use client";
import { createClient, errorMessage, notifyNavCounts, useViewer } from "@checkin/component-ui";
import { notifications } from "@mantine/notifications";

/**
 * Client fetch helpers. Every expense read and write goes through the host's routes under
 * /api/expense/*; the routes gate and filter server-side, so the client uses the caller's
 * roles only to decide which controls to show.
 */
const BASE = "/api/expense";

export const { api, useLoad } = createClient(BASE);

/**
 * Sends a write, shows the outcome, and reports whether it succeeded. A success tells the
 * host nav to refetch its pills, since any write can change the holds, flags or sign-off counts.
 */
export async function send(path: string, method: string, body: unknown, success: string): Promise<boolean> {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    notifyNavCounts();
    notifications.show({ message: success, color: "green" });
    return true;
  } catch (err) {
    // A refusal stays on screen until dismissed.
    notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
    return false;
  }
}

/** Leaves for `href`, as a fresh page load so every list and count is reread. */
export function goTo(href: string): void {
  window.location.assign(href);
}

/** The viewer's finance roles. */
export function useRoles(): { isFinance: boolean; isBoard: boolean } {
  const viewer = useViewer();
  return { isFinance: viewer?.isFinance === true, isBoard: viewer?.isBoardMember === true };
}

export { errorMessage, PAGE_SIZE, paged, type Loaded } from "@checkin/component-ui";

export interface Bucket {
  id: number;
  name: string;
  archivedAt: string | null;
}

/** Bucket picker options from the registered local-owners route (FINANCE and Board). */
export function useBuckets(enabled: boolean): { value: string; label: string }[] {
  const { data } = useLoad<Bucket[]>(enabled ? "/local-owners" : null);
  return (data ?? []).filter((b) => !b.archivedAt).map((b) => ({ value: String(b.id), label: b.name }));
}
