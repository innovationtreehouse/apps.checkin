import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { insertReceiptsTogether } from "../../lib/insert";
import { runFullFlow } from "../../lib/receipt-flow";
import { importReceipts } from "../../services/importService";

vi.mock("../../db", () => ({ db: { receiptDetail: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() } } }));
vi.mock("../../lib/insert", () => ({ insertReceiptsTogether: vi.fn() }));
vi.mock("../../lib/receipt-flow", () => ({ runFullFlow: vi.fn() }));
vi.mock("../../runtime", () => ({ requireActor: vi.fn().mockResolvedValue({ id: 1 }), getOrgId: vi.fn().mockResolvedValue("org-1") }));

const row = (importSourceId: string) => ({
  importSourceId,
  qbTxnId: "qb-1",
  retailer: "Hardware",
  receiptDate: "2023-03-01",
  shippingCents: 0,
  taxCents: 0,
  discountCents: 0,
  receiptTotalCents: 500,
  mimeType: "text/plain",
  fileBase64: Buffer.from(`historical ${importSourceId}`).toString("base64"),
  lineItems: [{ lineNumber: 1, description: "Nut", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false }],
});
const batch = [row("a"), row("b")];
const uniqueViolation = Object.assign(new Error("Unique constraint failed on secret_column"), { code: "P2002" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.receiptDetail.findMany).mockResolvedValue([]);
  vi.mocked(insertReceiptsTogether).mockRejectedValue(uniqueViolation);
});

describe("importReceipts losing a race to an overlapping run", () => {
  it("reports every row skipped when the other run loaded them all, and runs no pipeline", async () => {
    vi.mocked(db.receiptDetail.count).mockResolvedValue(2);

    const out = await importReceipts(batch);

    expect(out).toMatchObject({ processed: 0, skipped: 2 });
    expect(out.results).toEqual([
      { importSourceId: "a", status: "skipped" },
      { importSourceId: "b", status: "skipped" },
    ]);
    expect(runFullFlow).not.toHaveBeenCalled();
  });

  it("refuses with a 409 and no raw message when the other run loaded only some rows", async () => {
    vi.mocked(db.receiptDetail.count).mockResolvedValue(1);

    await expect(importReceipts(batch)).rejects.toMatchObject({ status: 409, message: expect.not.stringContaining("secret_column") });
  });

  it("still refuses with a 500 for a unique violation on some other key", async () => {
    vi.mocked(db.receiptDetail.count).mockResolvedValue(0);

    await expect(importReceipts(batch)).rejects.toMatchObject({ status: 500 });
  });
});
