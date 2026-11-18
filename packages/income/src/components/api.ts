"use client";
import { createClient, useViewer } from "@checkin/component-ui";

/**
 * Client fetch helpers. Every income read and write goes through the host's routes under
 * /api/income/*; the routes gate server-side, so the client only uses the caller's role to
 * decorate the UI.
 */
const BASE = "/api/income";

export const { api, useLoad } = createClient(BASE);

export { errorMessage, notifyNavCounts, refusalMessage, type Loaded } from "@checkin/component-ui";

/** Whether the viewer may act (resolve, run, map, exclude). Mirrors the routes' FINANCE gate. */
export function useIsFinance(): boolean {
  return useViewer()?.isFinance === true;
}

/** Whether the viewer is on the Board, who alone may raise an income cap. */
export function useIsBoard(): boolean {
  return useViewer()?.isBoardMember === true;
}
