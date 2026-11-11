"use client";
import { useEffect } from "react";
import { Badge } from "@mantine/core";
import { useLoad } from "./api";
import { NOT_PUSHED } from "./reviewQueue";
import { FINANCE_ACTION_STATES } from "../nav";

/** How many of the org's receipts each review queue holds, as GET /api/receipts/queue-counts returns them. */
export interface QueueCounts {
  byState: Record<string, number>;
  /** For a FINANCE viewer, the FINANCE queues' counts without receipts the viewer is conflicted on. */
  actionableByState?: Record<string, number>;
  /** Finalized receipts not yet delivered to receiving. */
  notPushed: number;
  /** Of those, the ones catch-up has stopped retrying. */
  pushGivenUp: number;
}

export const QUEUE_COUNTS_PATH = "/queue-counts";

/** The review queues' counts, reloaded whenever a receipt write tells the nav to refetch. */
export function useQueueCounts(): { counts: QueueCounts | null; error: string | null } {
  const { data, error, reload } = useLoad<QueueCounts>(QUEUE_COUNTS_PATH);
  useEffect(() => {
    window.addEventListener("nav-counts-mutated", reload);
    return () => window.removeEventListener("nav-counts-mutated", reload);
  }, [reload]);
  return { counts: data, error };
}

export interface QueueBadge {
  count: number;
  /** `action` when the viewer can move these receipts on; `info` when they can only read them. */
  intent: "action" | "info";
}

/**
 * The badge on `queue`'s tab. FINANCE acts on its queues and on undelivered receipts catch-up
 * gave up on, so those show green with the actionable count; every other non-empty queue
 * shows its total in gray. All has no badge.
 */
export function queueBadge(queue: string, counts: QueueCounts | null, isFinance: boolean): QueueBadge | null {
  if (!counts || !queue) return null;
  const total = queue === NOT_PUSHED ? counts.notPushed : (counts.byState[queue] ?? 0);
  const actionable = !isFinance
    ? 0
    : queue === NOT_PUSHED
      ? counts.pushGivenUp
      : FINANCE_ACTION_STATES.includes(queue)
        ? (counts.actionableByState?.[queue] ?? 0)
        : 0;
  if (actionable > 0) return { count: actionable, intent: "action" };
  return total > 0 ? { count: total, intent: "info" } : null;
}

/**
 * A queue tab's count pill, in the host CountBadge's action and info looks. On a selected (green)
 * tab the action pill turns gray with green text so it stands out from the button.
 */
export function QueueCount({ badge, selected = false }: { badge: QueueBadge | null; selected?: boolean }) {
  if (!badge) return null;
  const look =
    badge.intent === "info"
      ? { color: "gray.2", c: "gray.8" }
      : selected
        ? { color: "gray.2", c: "treehouseGreen.9" }
        : { color: "treehouseGreen", c: "black" };
  return (
    <Badge size="sm" variant="filled" {...look} aria-label={`${badge.count} ${badge.intent === "action" ? "to act on" : "in this queue"}`}>
      {badge.count}
    </Badge>
  );
}
