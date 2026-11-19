import { describe, expect, it } from "vitest";
import { create } from "../../routes/conversionChallenges";

const post = (body: unknown) => ({
  req: new Request("http://test/api/catalog/conversion-challenges", { method: "POST", body: JSON.stringify(body) }),
  params: {},
});

const VALID = { itemReferenceId: 1, proposedFactor: 3, reason: "Sold in 3-packs" };

describe("POST /api/catalog/conversion-challenges body", () => {
  it.each([
    ["a fractional factor", { proposedFactor: 2.5 }],
    ["a zero factor", { proposedFactor: 0 }],
    ["a factor sent as text", { proposedFactor: "3" }],
    ["a blank reason", { reason: "   " }],
    ["a reason over 500 characters", { reason: "x".repeat(501) }],
    ["a missing reference", { itemReferenceId: undefined }],
  ])("refuses %s with 400", async (_label, override) => {
    await expect(create(post({ ...VALID, ...override }))).rejects.toMatchObject({ status: 400 });
  });
});
