import { describe, expect, it } from "vitest";
import { catchUpSummary, type MailRunSummaryView } from "../../components/MailCatchUp";

const run = (over: Partial<MailRunSummaryView> = {}): MailRunSummaryView => ({
  status: "ok", messages: 12, receipts: 9, held: 2, waiting: 0, failed: 0, more: false, ...over,
});

describe("catchUpSummary", () => {
  it("shows the run's counts", () => {
    expect(catchUpSummary(run())).toBe("12 messages read, 9 receipts made, 2 held, 0 still waiting.");
  });

  it("asks for another run while work remains, and names failures", () => {
    expect(catchUpSummary(run({ waiting: 4, failed: 1, more: true }))).toBe(
      "12 messages read, 9 receipts made, 2 held, 4 still waiting, 1 failed. Run it again to continue.",
    );
  });

  it("explains a run that could not list the mailbox or stopped with an error", () => {
    expect(catchUpSummary(run({ status: "listing_failed" }))).toMatch(/couldn't read the mailbox/);
    expect(catchUpSummary(run({ status: "crashed" }))).toMatch(/stopped with an error.*Run it again/);
  });
});
