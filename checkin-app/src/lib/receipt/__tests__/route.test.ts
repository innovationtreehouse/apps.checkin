/**
 * @jest-environment node
 */
import { accessOf, readJsonCapped } from "@/lib/receipt/route";

describe("accessOf", () => {
  it("acts org-wide only for the finance and board views", () => {
    expect(accessOf("isFinance")).toBe("finance");
    expect(accessOf("isBoardMember")).toBe("finance");
    expect(accessOf("authenticated")).toBe("submitter");
    expect(accessOf("isSysadmin")).toBe("submitter");
  });
});

describe("readJsonCapped", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  async function* body(text: string) {
    yield bytes(text);
  }

  it("parses a JSON body within the cap", async () => {
    await expect(readJsonCapped(body('[{"a":1}]'), null, 100, "split it")).resolves.toEqual([{ a: 1 }]);
  });

  it("refuses an over-cap batch with the caller's message", async () => {
    const big = JSON.stringify([{ fileBase64: "x".repeat(200) }]);
    await expect(readJsonCapped(body(big), null, 100, "split it")).rejects.toMatchObject({ status: 413, message: "split it" });
    await expect(readJsonCapped(body("[]"), "101", 100, "split it")).rejects.toMatchObject({ status: 413, message: "split it" });
  });

  it("answers 400 for a body that is not JSON", async () => {
    await expect(readJsonCapped(body("not json"), null, 100, "split it")).rejects.toMatchObject({ status: 400 });
  });
});
