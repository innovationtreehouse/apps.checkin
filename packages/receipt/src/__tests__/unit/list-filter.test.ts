import { describe, expect, it } from "vitest";
import { listFilterWhere, parseListFilter } from "../../lib/listFilter";

const parse = (query: string) => parseListFilter(new URLSearchParams(query));

describe("parseListFilter", () => {
  it("reads no filter as every receipt", () => {
    expect(parse("")).toEqual({ state: undefined });
  });

  it("reads a state", () => {
    expect(parse("state=submitter_review")).toEqual({ state: "submitter_review" });
  });

  it.each([
    ["0", false],
    ["1", true],
  ])("reads pushed=%s", (value, pushed) => {
    expect(parse(`state=receipt_finalized&pushed=${value}`)).toEqual({ state: "receipt_finalized", pushed });
  });

  it("ignores an empty pushed", () => {
    expect(parse("state=receipt_finalized&pushed=")).toEqual({ state: "receipt_finalized" });
  });

  it("refuses any other pushed value with a 400 naming it", () => {
    expect(() => parse("pushed=no")).toThrow(expect.objectContaining({ status: 400, message: 'pushed must be 0 or 1, not "no"' }));
  });
});

describe("listFilterWhere", () => {
  it("scopes to the org alone with no filter", () => {
    expect(listFilterWhere("org1", {})).toEqual({ orgId: "org1" });
  });

  it("narrows to one state", () => {
    expect(listFilterWhere("org1", { state: "discarded" })).toEqual({ orgId: "org1", details: { state: "discarded" } });
  });

  it("keeps finalized receipts that never reached receiving", () => {
    expect(listFilterWhere("org1", { state: "receipt_finalized", pushed: false })).toEqual({
      orgId: "org1",
      details: { state: "receipt_finalized" },
      pushedAt: null,
    });
  });

  it("keeps receipts that reached receiving", () => {
    expect(listFilterWhere("org1", { pushed: true })).toEqual({ orgId: "org1", pushedAt: { not: null } });
  });
});
