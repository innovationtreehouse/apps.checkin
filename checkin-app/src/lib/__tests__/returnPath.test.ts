import { returnPath } from "@/lib/returnPath";

describe("returnPath", () => {
  it("keeps an in-app path and its query", () => {
    expect(returnPath("/expense/holds", "/x")).toBe("/expense/holds");
    expect(returnPath("/expense/expenses?view=qb_pending&page=2", "/x")).toBe("/expense/expenses?view=qb_pending&page=2");
  });

  it("takes the first of repeated params", () => {
    expect(returnPath(["/expense/flags", "/expense/holds"], "/x")).toBe("/expense/flags");
  });

  it("normalizes dot segments that stay on the site", () => {
    expect(returnPath("/expense/../expense/holds", "/x")).toBe("/expense/holds");
  });

  it.each([
    undefined, "", "expense/holds", "//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)",
    "/..//evil.example", "/.//evil.example", "/foo/..//evil.example", "/%2e%2e//evil.example", "/x/%2E%2E//evil.example",
  ])(
    "falls back for %p",
    (from) => {
      expect(returnPath(from, "/expense/expenses")).toBe("/expense/expenses");
    },
  );
});
