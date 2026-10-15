import { describe, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { create } from "../../routes/itemReferences";

const post = (body: object) =>
  new Request("http://test/api/catalog/item-references", { method: "POST", body: JSON.stringify(body) });

describe("item reference url accepts only http(s) links", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x", "not a url"]) {
    it(`rejects ${url}`, async () => {
      await expect(create({ req: post({ gtin13: "0000000000017", url }), params: {} })).rejects.toMatchObject({
        status: 400,
      });
    });
  }
});

describeDb("item reference url passes validation for an https link", () => {
  it("reaches the item lookup instead of a 400", async () => {
    await expect(
      create({ req: post({ gtin13: "9999999999999", url: "https://example.com/part" }), params: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
