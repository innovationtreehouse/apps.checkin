"use client";
import { createClient, useViewer } from "@checkin/component-ui";

export { errorMessage, notifyNavCounts, type Loaded } from "@checkin/component-ui";

/**
 * Client fetch helpers over the host's /api/workflow-mapping/* routes. The
 * routes gate server-side; the client reads the caller's role only to decide
 * which controls to show.
 */
export const { api, useLoad } = createClient("/api/workflow-mapping");

/** Mirrors the write routes' INVENTORY_MANAGER gate. */
export function useCanManage(): boolean {
  return useViewer()?.isInventoryManager === true;
}

export { STATE_LABEL } from "../lib/stateLabels";

export const STATE_COLOR: Record<string, string> = {
  pending_review: "yellow",
  applying: "blue",
  apply_failed: "red",
  resolved: "green",
};

/** A line's mapping decision, in plain words. */
export const LINE_STATUS_LABEL: Record<string, string> = {
  unrecognized: "Unrecognized",
  recognized: "Recognized",
  provisional: "Provisional",
  non_inventory: "Not inventory",
};

export const LINE_STATUS_COLOR: Record<string, string> = {
  unrecognized: "yellow",
  recognized: "green",
  provisional: "violet",
  non_inventory: "gray",
};
