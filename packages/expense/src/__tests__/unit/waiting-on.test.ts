import { describe, expect, it } from "vitest";
import { waitingOnLabel } from "../../lib/waiting-on";

describe("waitingOnLabel", () => {
  it("names an unknown reimbursee before any seat", () => {
    expect(waitingOnLabel("qb_pending", true, ["SUBMITTER", "TREASURER"])).toBe("Reimbursee not found");
  });

  it("names the submitter's missing confirmation", () => {
    expect(waitingOnLabel("qb_pending", false, ["TREASURER", "SUBMITTER"])).toBe("Awaiting submitter confirmation");
  });

  it("names the unsigned Treasurer seat", () => {
    expect(waitingOnLabel("qb_pending", false, ["BOARD", "TREASURER"])).toBe("Awaiting Treasurer signature");
  });

  it("names the unsigned Board seat", () => {
    expect(waitingOnLabel("qb_pending", false, ["BOARD_APPROVAL", "BOARD"])).toBe("Awaiting Board signature");
  });

  it("names the Board's missing approval", () => {
    expect(waitingOnLabel("qb_pending", false, ["BOARD_APPROVAL"])).toBe("Awaiting Board approval");
  });

  it("keeps QB Pending when nothing holds the expense", () => {
    expect(waitingOnLabel("qb_pending", false, [])).toBe("QB Pending");
  });

  it("keeps another state's label whatever its holds", () => {
    expect(waitingOnLabel("owner_approval", true, ["TREASURER"])).toBe("Owner Approval");
  });
});
