import { returnPath } from "@/lib/returnPath";

describe("returnPath", () => {
  it("keeps an in-app path and its query", () => {
    expect(returnPath("/expense/holds", "/x")).toBe("/expense/holds");
    expect(returnPath("/expense/expenses?view=qb_pending&page=2", "/x")).toBe("/expense/expenses?view=qb_pending&page=2");
  });

  it("takes the first of repeated params", () => {
    expect(returnPath(["/expense/flags", "/expense/holds"], "/x")).toBe("/expense/flags");
  });

  it.each([undefined, "", "expense/holds", "//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)"])(
    "falls back for %p",
    (from) => {
      expect(returnPath(from, "/expense/expenses")).toBe("/expense/expenses");
    },
  );
});
