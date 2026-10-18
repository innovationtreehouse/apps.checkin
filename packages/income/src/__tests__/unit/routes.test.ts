/** Request-body validation: every malformed body is a 400 before any service or database call. */
import { describe, expect, it } from "vitest";
import { excludeDeposit, resolve, setItemCategory } from "../../routes";

const post = (body: string) => new Request("http://test/api/income", { method: "POST", body });
const json = (body: unknown) => post(JSON.stringify(body));

describe("resolve body", () => {
  const call = (req: Request) => resolve({ req, params: { id: "1" } });

  it.each([
    ["not JSON", post("{"), "Invalid JSON body"],
    ["an array", json([]), "Expected a JSON object"],
    ["null", json(null), "Expected a JSON object"],
    ["no action", json({}), "action must be match, dismiss, retry or book"],
    ["an unknown action", json({ action: "delete" }), "action must be match, dismiss, retry or book"],
    ["match without depositId", json({ action: "match" }), "depositId is required"],
    ["match with a blank depositId", json({ action: "match", depositId: "  " }), "depositId is required"],
    ["match with a non-string reason", json({ action: "match", depositId: "D1", reason: 5 }), "reason must be a string"],
    ["dismiss without reason", json({ action: "dismiss" }), "reason is required"],
    ["dismiss with a blank reason", json({ action: "dismiss", reason: " " }), "reason is required"],
  ])("is a 400 for %s", async (_, req, message) => {
    await expect(call(req)).rejects.toMatchObject({ status: 400, message });
  });
});

describe("setItemCategory body", () => {
  const call = (req: Request) => setItemCategory({ req, params: { variantId: "42" } });

  it.each([
    ["an array", json([]), "Expected a JSON object"],
    ["no budgetOwnerId", json({}), "budgetOwnerId must be a positive integer or null"],
    ["a string", json({ budgetOwnerId: "3" }), "budgetOwnerId must be a positive integer or null"],
    ["a fraction", json({ budgetOwnerId: 1.5 }), "budgetOwnerId must be a positive integer or null"],
    ["zero", json({ budgetOwnerId: 0 }), "budgetOwnerId must be a positive integer or null"],
  ])("is a 400 for %s", async (_, req, message) => {
    await expect(call(req)).rejects.toMatchObject({ status: 400, message });
  });
});

describe("excludeDeposit body", () => {
  const call = (req: Request) => excludeDeposit({ req, params: {} });

  it.each([
    ["an array", json([]), "Expected a JSON object"],
    ["no qbTxnId", json({ reason: "r" }), "qbTxnId is required"],
    ["no reason", json({ qbTxnId: "Q1" }), "reason is required"],
    ["a blank reason", json({ qbTxnId: "Q1", reason: "" }), "reason is required"],
  ])("is a 400 for %s", async (_, req, message) => {
    await expect(call(req)).rejects.toMatchObject({ status: 400, message });
  });
});
