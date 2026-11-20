/** A Problems-list retry of a stuck gift returns only when its step succeeded; every other outcome throws. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { postGift } from "../../lib/in-kind-poster";

type Outcome = Awaited<ReturnType<typeof postGift>>;
const state = vi.hoisted(() => ({ outcome: "posted" as string, register: "registered" as string, retried: [] as unknown[][] }));
const FAILED_AT = new Date("2026-11-02T10:00:00Z");

vi.mock("../../db", () => ({
  db: { inKindPosting: { findFirst: async () => ({ id: 1 }), findMany: async () => [{ source: "manual", giftId: 3, qbFirstFailedAt: FAILED_AT }] } },
}));
vi.mock("../../runtime", () => ({ getOrgId: async () => "org-1" }));
vi.mock("../../services/inKindCapitalService", () => ({
  inKindRegistration: {
    stuckRegistrations: async () => [{ source: "receipt", id: 5, failedAt: FAILED_AT }],
    retryRegistration: async (...args: unknown[]) => {
      state.retried.push(args);
      return state.register;
    },
  },
}));
vi.mock("../../lib/in-kind-resolve", () => ({ openRun: async () => ({}) }));
vi.mock("../../lib/in-kind-poster", () => ({ IN_KIND_HELD_STATES: ["POST_FAILED"], postGift: async () => state.outcome }));

import { retryStuckItem, stuckItems } from "../../stuckItems";

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

describe("the capital asset registration step", () => {
  const retryRegistration = (id = "receipt 5") => retryStuckItem({ id, step: "capital asset registration" });

  beforeEach(() => {
    state.register = "registered";
    state.retried = [];
  });

  it("is listed beside the posting step, linked to the gift and timed by its first failure", async () => {
    expect(await stuckItems()).toEqual([
      { id: "manual 3", step: "QuickBooks posting", href: "/donations/in-kind/manual/3", failedAt: FAILED_AT },
      { id: "receipt 5", step: "capital asset registration", href: "/donations/in-kind/receipt/5", failedAt: FAILED_AT },
    ]);
  });

  it("registers once and returns when the lines were registered", async () => {
    await expect(retryRegistration()).resolves.toBeUndefined();
    expect(state.retried).toEqual([["org-1", "receipt", 5]]);
  });

  it.each([
    ["not_stuck", 404],
    ["system", 503],
    ["connection", 503],
    ["data", 409],
    ["bug", 409],
    ["settings", 409],
  ])("answers %s with %i and no error text", async (outcome, status) => {
    state.register = outcome;
    const failed = await retryRegistration().catch((e: unknown) => e);
    expect(failed).toMatchObject({ status });
    expect((failed as Error).message).toMatch(/^(Retried|No failed)/);
  });

  it("answers 404 for an unknown source without registering", async () => {
    await expect(retryRegistration("other 5")).rejects.toMatchObject({ status: 404 });
    expect(state.retried).toEqual([]);
  });
});
