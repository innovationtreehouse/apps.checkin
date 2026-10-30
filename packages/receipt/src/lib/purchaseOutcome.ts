/** A finalized receipt's downstream outcome in plain words, for its uploader and reimbursee. */
import type { PurchaseOutcome } from "../contract";

export type PurchaseOutcomeView = PurchaseOutcome | { unavailable: true } | null | undefined;

export interface OutcomeStep {
  label: string;
  /** Red for a refusal, green once done, otherwise neutral. */
  tone: "done" | "refused" | "waiting";
  notes: string[];
}

const RECEIVING: Record<NonNullable<PurchaseOutcome["receiving"]>, OutcomeStep> = {
  waiting: { label: "Waiting for receiving", tone: "waiting", notes: [] },
  applying: { label: "Being received", tone: "waiting", notes: [] },
  stuck: { label: "Held up in receiving", tone: "waiting", notes: [] },
  received: { label: "Received", tone: "done", notes: [] },
};

const MONEY: Record<NonNullable<PurchaseOutcome["money"]>["status"], Omit<OutcomeStep, "notes">> = {
  awaiting_confirmation: { label: "Waiting for the person reimbursed to confirm", tone: "waiting" },
  awaiting_approval: { label: "Waiting on approval", tone: "waiting" },
  exception: { label: "An approver raised a question", tone: "waiting" },
  with_finance: { label: "With finance", tone: "waiting" },
  line_rejected: { label: "Line rejected", tone: "refused" },
  complete: { label: "Complete", tone: "done" },
  backfill: { label: "Complete (booked earlier)", tone: "done" },
};

const GIFT: Record<NonNullable<PurchaseOutcome["gift"]>, OutcomeStep> = {
  awaiting_decision: { label: "Gift waiting for finance", tone: "waiting", notes: [] },
  accepted: { label: "Gift accepted", tone: "done", notes: [] },
  refused: { label: "Gift refused", tone: "refused", notes: [] },
  returned: { label: "Gift returned", tone: "refused", notes: [] },
};

/** Each step the purchase has reached, in flow order: receiving, then the money or the gift. */
export function outcomeSteps(outcome: PurchaseOutcomeView): OutcomeStep[] {
  if (!outcome) return [];
  if ("unavailable" in outcome) return [{ label: "Status unavailable", tone: "waiting", notes: [] }];
  const steps: OutcomeStep[] = [];
  steps.push(outcome.receiving ? RECEIVING[outcome.receiving] : { label: "Not yet sent to receiving", tone: "waiting", notes: [] });
  if (outcome.money) steps.push({ ...MONEY[outcome.money.status], notes: outcome.money.notes });
  if (outcome.gift) steps.push(GIFT[outcome.gift]);
  return steps;
}

/** The furthest step, for a one-line summary on a list row. */
export function latestOutcome(outcome: PurchaseOutcomeView): OutcomeStep | null {
  const steps = outcomeSteps(outcome);
  return steps.length ? steps[steps.length - 1] : null;
}
