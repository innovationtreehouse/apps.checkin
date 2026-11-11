"use client";
import { createClient, useViewer } from "@checkin/component-ui";

/**
 * Client fetch helpers. Every income read and write goes through the host's routes under
 * /api/income/*; the routes gate server-side, so the client only uses the caller's role to
 * decorate the UI.
 */
const BASE = "/api/income";

export const { api, useLoad } = createClient(BASE);

export { errorMessage, notifyNavCounts, type Loaded } from "@checkin/component-ui";

/** Whether the viewer may act (resolve, run, map, exclude). Mirrors the routes' FINANCE gate. */
export function useIsFinance(): boolean {
  return useViewer()?.isFinance === true;
}
