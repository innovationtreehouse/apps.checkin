import { describe, it, expect } from "vitest";
import { form990DeleteAfter, form990DueBefore } from "./index";

describe("form990DeleteAfter", () => {
  it("keeps a record through November 15, the given years after its fiscal year's Form 990 deadline", () => {
    expect(form990DeleteAfter("2025-07-01", 7)).toEqual(new Date("2033-11-16T00:00:00Z"));
    expect(form990DeleteAfter("2026-06-30", 7)).toEqual(new Date("2033-11-16T00:00:00Z"));
    expect(form990DeleteAfter("2026-07-01", 7)).toEqual(new Date("2034-11-16T00:00:00Z"));
  });

  it("reads an ISO timestamp by its UTC day", () => {
    expect(form990DeleteAfter("2026-06-30T23:59:59.999Z", 7)).toEqual(new Date("2033-11-16T00:00:00Z"));
    expect(form990DeleteAfter("2026-07-01T00:00:00.000Z", 7)).toEqual(new Date("2034-11-16T00:00:00Z"));
  });
});

describe("form990DueBefore", () => {
  it("moves to the next fiscal year on November 16, not before", () => {
    expect(form990DueBefore(new Date("2033-11-15T23:59:59Z"), 7)).toEqual(new Date("2025-07-01T00:00:00Z"));
    expect(form990DueBefore(new Date("2033-11-16T00:00:00Z"), 7)).toEqual(new Date("2026-07-01T00:00:00Z"));
    expect(form990DueBefore(new Date("2034-03-01T00:00:00Z"), 7)).toEqual(new Date("2026-07-01T00:00:00Z"));
  });

  it("agrees with form990DeleteAfter: a record is due exactly when it is dated before the cutoff", () => {
    const nows = ["2033-11-15T12:00:00Z", "2033-11-16T00:00:00Z", "2034-01-01T00:00:00Z", "2034-07-01T00:00:00Z", "2034-11-16T00:00:00Z"];
    const days = ["2025-06-30", "2025-07-01", "2026-06-30", "2026-07-01", "2026-12-31", "2027-06-30", "2027-07-01"];
    for (const n of nows) {
      const now = new Date(n);
      const cutoff = form990DueBefore(now, 7);
      for (const day of days) {
        const at = new Date(`${day}T12:00:00Z`);
        expect(form990DeleteAfter(day, 7) <= now, `${day} at ${n}`).toBe(at < cutoff);
      }
    }
  });
});
