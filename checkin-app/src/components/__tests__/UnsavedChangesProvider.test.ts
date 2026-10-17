import { shallowEqual } from "@/components/UnsavedChangesProvider";

describe("shallowEqual (unsaved-changes dirty compare)", () => {
  const base = { fee: "10.00", months: "12", code: "", boundary: "" };

  it("is equal to an identical snapshot (clean form → not dirty)", () => {
    expect(shallowEqual(base, { ...base })).toBe(true);
  });

  it("detects a changed value (edited field → dirty)", () => {
    expect(shallowEqual(base, { ...base, fee: "20.00" })).toBe(false);
  });

  it("does not coerce types ('12' !== 12)", () => {
    expect(shallowEqual({ n: "12" }, { n: 12 })).toBe(false);
  });

  it("treats differing key counts as not equal", () => {
    expect(shallowEqual({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });

  it("handles null values", () => {
    expect(shallowEqual({ a: null }, { a: null })).toBe(true);
    expect(shallowEqual({ a: null }, { a: "" })).toBe(false);
  });
});
