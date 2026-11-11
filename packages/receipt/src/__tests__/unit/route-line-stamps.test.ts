import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptRouteCtx } from "../../contract";
import { addLine, editLine, get } from "../../routes/receipts";
import { receiptService } from "../../services/receiptService";

vi.mock("../../services/receiptService", () => ({
  receiptService: { get: vi.fn(), addLine: vi.fn(), editLine: vi.fn() },
}));

const ctx = (over: Partial<ReceiptRouteCtx> = {}): ReceiptRouteCtx => ({
  req: new Request("http://test/", { method: "POST", body: JSON.stringify({ description: "Saw" }) }),
  params: { id: "r-1", lineItemId: "5" },
  access: "submitter",
  financeActorId: null,
  submitterActorId: 7,
  ...over,
});

describe("line owner stamps", () => {
  beforeEach(() => {
    vi.mocked(receiptService.addLine).mockResolvedValue({ id: 5 } as never);
    vi.mocked(receiptService.editLine).mockResolvedValue({ id: 5 } as never);
  });

  it("stamps every line of a read with the receipt's uploader, in either view", async () => {
    vi.mocked(receiptService.get).mockResolvedValue({ uploadedByUserId: 9, lineItems: [{ id: 1 }, { id: 2 }] } as never);
    const lines = [{ id: 1, uploadedByUserId: 9 }, { id: 2, uploadedByUserId: 9 }];
    await expect(get(ctx({ access: "finance", submitterActorId: null }))).resolves.toEqual({ ReceiptView: { uploadedByUserId: 9, lineItems: lines } });
    await expect(get(ctx())).resolves.toEqual({ ReceiptView: { uploadedByUserId: 9, lineItems: lines } });
    expect(receiptService.get).toHaveBeenLastCalledWith("r-1", "submitter");
  });

  it("stamps a submitter's written line with their own id", async () => {
    await expect(addLine(ctx())).resolves.toEqual({ ReceiptLineView: { id: 5, uploadedByUserId: 7 } });
    await expect(editLine(ctx())).resolves.toEqual({ ReceiptLineView: { id: 5, uploadedByUserId: 7 } });
    expect(receiptService.addLine).toHaveBeenCalledWith("r-1", "submitter", { description: "Saw" });
    expect(receiptService.editLine).toHaveBeenCalledWith("r-1", "submitter", 5, { description: "Saw" });
  });

  it("leaves finance's written line unstamped", async () => {
    await expect(addLine(ctx({ access: "finance", submitterActorId: null }))).resolves.toEqual({ ReceiptLineView: { id: 5 } });
    await expect(editLine(ctx({ access: "finance", submitterActorId: null }))).resolves.toEqual({ ReceiptLineView: { id: 5 } });
  });

  it("answers 401 for a submitter write with no session person", async () => {
    await expect(addLine(ctx({ submitterActorId: null }))).rejects.toMatchObject({ status: 401, message: "Unauthorized" });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const req = new Request("http://test/", { method: "POST", body: "{" });
    await expect(addLine(ctx({ req }))).rejects.toMatchObject({ status: 400, message: "Invalid JSON body" });
  });
});
