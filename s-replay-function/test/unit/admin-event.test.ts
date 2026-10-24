import { describe, it, expect } from "vitest";
import { AdminEventSchema } from "../../src/handler.js";

const base = { mode: "replay", actor: "ops:jane", reason: "reproject after fix" } as const;

describe("AdminEventSchema", () => {
  it("accepts a well-formed replay event", () => {
    const parsed = AdminEventSchema.parse({ ...base, objectType: "ORDER", since: "2026-01-01T00:00:00Z" });
    expect(parsed.mode).toBe("replay");
    expect(parsed.actor).toBe("ops:jane");
    expect(parsed.reason).toBe("reproject after fix");
  });

  it("requires actor (audit attribution)", () => {
    expect(() => AdminEventSchema.parse({ mode: "replay", reason: "x" })).toThrow();
  });

  it("requires reason (audit justification)", () => {
    expect(() => AdminEventSchema.parse({ mode: "replay", actor: "ops:jane" })).toThrow();
  });

  it("rejects a non-ISO since", () => {
    expect(() => AdminEventSchema.parse({ ...base, since: "yesterday" })).toThrow();
  });

  it("rejects an invalid objectType", () => {
    expect(() => AdminEventSchema.parse({ ...base, objectType: "WIDGET" })).toThrow();
  });

  it("rejects unknown keys (strict contract)", () => {
    expect(() => AdminEventSchema.parse({ ...base, sneaky: true })).toThrow();
  });

  it("accepts reset-watermark with a null `to`", () => {
    const parsed = AdminEventSchema.parse({
      mode: "reset-watermark",
      objectType: "PAYOUT",
      actor: "ops:jane",
      reason: "clear",
      to: null,
    });
    expect(parsed.mode).toBe("reset-watermark");
    expect(parsed.to).toBeNull();
  });

  it("accepts reingest-bulk with a since floor and bulk operation id", () => {
    const parsed = AdminEventSchema.parse({
      mode: "reingest-bulk",
      actor: "ops:jane",
      reason: "repair backfill after reassembly fix",
      since: "2026-01-01T00:00:00Z",
      bulkOperationId: "gid://shopify/BulkOperation/123",
    });
    expect(parsed.mode).toBe("reingest-bulk");
    expect(parsed.bulkOperationId).toBe("gid://shopify/BulkOperation/123");
  });
});

describe("AdminEventSchema unfiltered-scope guard", () => {
  const audit = { actor: "ops:jane", reason: "why" };
  const cases = [
    { mode: "replay", filters: ["objectType", "gid", "since"] },
    { mode: "reset-watermark", filters: ["objectType"] },
    { mode: "reingest-bulk", filters: ["since", "bulkOperationId"] },
  ] as const;
  const filterValues = {
    objectType: "ORDER",
    gid: "gid://shopify/Order/1",
    since: "2026-01-01T00:00:00Z",
    bulkOperationId: "gid://shopify/BulkOperation/1",
  } as const;

  it.each(cases)("$mode: refuses an unfiltered call without scope, naming the missing filters", ({ mode, filters }) => {
    const res = AdminEventSchema.safeParse({ mode, ...audit });
    expect(res.success).toBe(false);
    const message = res.error?.issues.map((i) => i.message).join("; ") ?? "";
    for (const f of filters) expect(message).toContain(f);
    expect(message).toContain('"scope": "all"');
  });

  it.each(cases)("$mode: accepts an unfiltered call with scope: \"all\"", ({ mode }) => {
    expect(AdminEventSchema.parse({ mode, scope: "all", ...audit }).scope).toBe("all");
  });

  it.each(cases.flatMap(({ mode, filters }) => filters.map((filter) => ({ mode, filter }))))(
    "$mode: accepts a call filtered by $filter alone",
    ({ mode, filter }) => {
      expect(AdminEventSchema.safeParse({ mode, [filter]: filterValues[filter], ...audit }).success).toBe(true);
    },
  );

  it("rejects a scope other than \"all\"", () => {
    expect(AdminEventSchema.safeParse({ mode: "replay", scope: "some", ...audit }).success).toBe(false);
  });

  it("reset-watermark: a `to` alone does not narrow (it still covers every object type)", () => {
    expect(AdminEventSchema.safeParse({ mode: "reset-watermark", to: "2026-01-01T00:00:00Z", ...audit }).success).toBe(false);
  });
});
