/** A Problems-list retry of a stuck gift returns only when the gift reached the books; every other outcome throws. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { postGift } from "../../lib/in-kind-poster";

type Outcome = Awaited<ReturnType<typeof postGift>>;
const state = vi.hoisted(() => ({ outcome: "posted" as string }));

vi.mock("../../db", () => ({ db: { inKindPosting: { findFirst: async () => ({ id: 1 }) } } }));
vi.mock("../../runtime", () => ({ getOrgId: async () => "org-1" }));
vi.mock("../../lib/in-kind-resolve", () => ({ openRun: async () => ({}) }));
vi.mock("../../lib/in-kind-poster", () => ({ IN_KIND_HELD_STATES: ["POST_FAILED"], postGift: async () => state.outcome }));

import { retryStuckItem } from "../../stuckItems";

const retry = () => retryStuckItem({ id: "receipt 5", step: "QuickBooks posting" });

describe("retryStuckItem", () => {
  beforeEach(() => {
    state.outcome = "posted";
  });

  it.each<Outcome>(["posted", "matched"])("returns when the gift is %s", async (outcome) => {
    state.outcome = outcome;
    await expect(retry()).resolves.toBeUndefined();
  });

  it.each<[Outcome, number]>([
    ["failed", 503],
    ["waiting", 409],
    ["not_ready", 409],
    ["busy", 409],
    ["unbooked", 409],
    ["needs_finance", 409],
    ["held", 409],
  ])("throws when the gift is %s", async (outcome, status) => {
    state.outcome = outcome;
    await expect(retry()).rejects.toMatchObject({ status });
  });

  it("throws on an outcome it does not know", async () => {
    state.outcome = "something new";
    await expect(retry()).rejects.toMatchObject({ status: 409 });
  });
});
