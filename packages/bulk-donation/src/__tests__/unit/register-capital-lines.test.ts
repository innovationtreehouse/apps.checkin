/** Registration runs before the in-kind drain; a database it cannot read is reported, never thrown, so the drain still runs. */
import { describe, it, expect, vi } from "vitest";

const failed = vi.hoisted(() => vi.fn(() => "settings"));
vi.mock("../../db", () => ({
  db: {
    inKindDonationLine: { findMany: async () => { throw new Error("BULK_DONATION_DATABASE_URL is not set"); } },
    manualInKindDonationLine: { findMany: async () => [] },
  },
}));
vi.mock("../../runtime", () => ({ bulkDonationRuntime: { failed }, getInKindCapital: vi.fn(), getOrgId: vi.fn() }));
vi.mock("../../services/inKindAcceptService", () => ({}));

import { registerCapitalLines } from "../../services/inKindCapitalService";

describe("registerCapitalLines", () => {
  it("reports a failed read of the waiting lines and registers nothing", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(registerCapitalLines("org-1")).resolves.toEqual({ registered: 0, failed: 0 });
    expect(failed).toHaveBeenCalledWith("in-kind-capital-register", expect.any(Error), "the capital lines waiting on registration");
    warned.mockRestore();
  });
});
