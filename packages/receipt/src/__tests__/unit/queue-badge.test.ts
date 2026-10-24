import { describe, expect, it } from "vitest";
import { queueBadge, type QueueCounts } from "../../components/queueCounts";

const counts: QueueCounts = {
  byState: { financial_review: 3, duplicate_flagged: 0, validation_failed: 2, submitter_review: 4, flow_error: 1 },
  notPushed: 5,
  pushGivenUp: 2,
};

describe("queueBadge", () => {
  it.each([
    ["financial_review", { count: 3, intent: "action" }],
    ["flow_error", { count: 1, intent: "action" }],
    ["validation_failed", { count: 2, intent: "info" }],
    ["submitter_review", { count: 4, intent: "info" }],
    ["not_pushed", { count: 2, intent: "action" }],
  ])("for FINANCE, %s shows %j", (queue, badge) => {
    expect(queueBadge(queue, counts, true)).toEqual(badge);
  });

  it.each([
    ["financial_review", { count: 3, intent: "info" }],
    ["not_pushed", { count: 5, intent: "info" }],
  ])("for the Board, %s shows %j: it reads but does not act", (queue, badge) => {
    expect(queueBadge(queue, counts, false)).toEqual(badge);
  });

  it("shows the undelivered total in gray once nothing has been given up on", () => {
    expect(queueBadge("not_pushed", { ...counts, pushGivenUp: 0 }, true)).toEqual({ count: 5, intent: "info" });
  });

  it.each(["duplicate_flagged", "discarded"])("shows nothing for an empty or uncounted queue (%s)", (queue) => {
    expect(queueBadge(queue, counts, true)).toBeNull();
  });

  it("shows nothing on All, or before the counts load", () => {
    expect(queueBadge("", counts, true)).toBeNull();
    expect(queueBadge("financial_review", null, true)).toBeNull();
  });
});
