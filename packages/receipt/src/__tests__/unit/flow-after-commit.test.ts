import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { audit, ReceiptStateConflictError, receiptRepo, recordFailure } from "../../repositories/receipt";
import { receiptService } from "../../services/receiptService";

const tx = {};
vi.mock("../../db", () => ({ db: { $transaction: vi.fn() } }));
vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  requireActor: vi.fn().mockResolvedValue({ id: 7 }),
  getOrgId: vi.fn().mockResolvedValue("org-1"),
}));
vi.mock("../../repositories/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repositories/receipt")>()),
  receiptRepo: { find: vi.fn(), update: vi.fn(), listLineItems: vi.fn() },
  audit: vi.fn(),
  recordFailure: vi.fn(),
}));

const base = {
  id: "r-1",
  orgId: "org-1",
  uploadedByUserId: 7,
  pushedAt: null,
  retailer: "Hardware",
  receiptDate: "2026-11-01",
  receiptTotalCents: 500,
  needsReimbursement: false,
  reimbursementFor: null,
  reimburseePersonId: null,
};
const inState = (state: string) => ({ ...base, state }) as never;
const outage = new Error("database went away");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(db.$transaction).mockImplementation(((work: (t: typeof tx) => unknown) => work(tx)) as never);
  vi.mocked(receiptRepo.listLineItems).mockRejectedValue(outage);
});

describe("a step that has committed answers as done when the flow after it fails", () => {
  it("resubmit returns the receipt, now in flow_error, with the failure recorded", async () => {
    vi.mocked(receiptRepo.find)
      .mockResolvedValueOnce(inState("validation_failed"))
      .mockResolvedValueOnce(inState("uploaded"))
      .mockResolvedValueOnce(inState("flow_error"));

    await expect(receiptService.resubmit("r-1", "submitter")).resolves.toMatchObject({ id: "r-1", state: "flow_error" });

    expect(audit).toHaveBeenCalledWith(tx, "r-1", { id: 7 }, expect.objectContaining({ action: "resubmitted" }));
    expect(receiptRepo.update).toHaveBeenCalledWith("r-1", { detail: { state: "flow_error" } }, "uploaded", tx);
    expect(audit).toHaveBeenCalledWith(tx, "r-1", { id: 7 }, expect.objectContaining({ action: "pipeline_failed", valueAfter: outage.message }));
    expect(recordFailure).toHaveBeenCalledWith(db, "r-1", outage);
  });

  it("submitter confirmation returns the receipt with the failure recorded", async () => {
    vi.mocked(receiptRepo.find)
      .mockResolvedValueOnce(inState("submitter_review"))
      .mockResolvedValueOnce(inState("uploaded"))
      .mockResolvedValueOnce(inState("flow_error"));

    await expect(receiptService.submitterConfirm("r-1")).resolves.toMatchObject({ id: "r-1", state: "flow_error" });

    expect(audit).toHaveBeenCalledWith(tx, "r-1", { id: 7 }, expect.objectContaining({ action: "submitter_review_confirmed" }));
    expect(recordFailure).toHaveBeenCalledWith(db, "r-1", outage);
  });
});

describe("a step that fails before it commits", () => {
  it("answers with its error and runs no flow", async () => {
    vi.mocked(receiptRepo.find).mockResolvedValueOnce(inState("validation_failed"));
    vi.mocked(receiptRepo.update).mockRejectedValueOnce(new ReceiptStateConflictError("validation_failed", "discarded"));

    await expect(receiptService.resubmit("r-1", "submitter")).rejects.toMatchObject({ status: 409 });

    expect(receiptRepo.find).toHaveBeenCalledTimes(1);
    expect(receiptRepo.listLineItems).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
