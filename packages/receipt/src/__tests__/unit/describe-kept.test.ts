import { describe, expect, it } from "vitest";
import { describeKept } from "../../lib/duplicateGroup";

const at = (iso: string) => new Date(iso);

describe("describeKept", () => {
  it("names the vendor and upload day", () => {
    const kept = { retailer: "Home Depot", uploadedAt: at("2026-10-03T14:05:00Z") };
    expect(describeKept(kept, [kept.uploadedAt, at("2026-10-05T09:00:00Z")])).toBe("Home Depot, uploaded 3 Oct");
  });

  it("adds the time when another copy was uploaded the same day", () => {
    const kept = { retailer: "Home Depot", uploadedAt: at("2026-10-03T14:05:00Z") };
    expect(describeKept(kept, [kept.uploadedAt, at("2026-10-03T09:00:00Z")])).toBe("Home Depot, uploaded 3 Oct, 14:05");
  });

  it("reads a receipt with no vendor as a receipt", () => {
    expect(describeKept({ retailer: " ", uploadedAt: at("2026-10-03T14:05:00Z") }, [])).toBe("Receipt, uploaded 3 Oct");
  });
});
