import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { receiptRepo } from "../../repositories/receipt";
import { LINE_COST_MESSAGE } from "../../lib/schemas";
import { receiptService } from "../../services/receiptService";

const tx = { $queryRaw: vi.fn(), receiptLineItem: { findFirst: vi.fn(), update: vi.fn() } };
vi.mock("../../db", () => ({ db: { $transaction: vi.fn() } }));
vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  requireActor: vi.fn().mockResolvedValue({ id: 7 }),
  getOrgId: vi.fn().mockResolvedValue("org-1"),
}));
vi.mock("../../repositories/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repositories/receipt")>()),
  receiptRepo: { find: vi.fn() },
  audit: vi.fn(),
}));

const row = { id: "r-1", orgId: "org-1", state: "submitter_review", uploadedByUserId: 7, pushedAt: null };
const line = { id: 5, receiptId: "r-1", description: "Saw", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 100_000, totalPriceCents: 100_000, isDelayed: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(receiptRepo.find).mockResolvedValue(row as never);
  vi.mocked(db.$transaction).mockImplementation(((work: (t: typeof tx) => unknown) => work(tx)) as never);
  tx.receiptLineItem.findFirst.mockResolvedValue(line);
  tx.receiptLineItem.update.mockImplementation(({ data }) => Promise.resolve({ ...line, ...data }));
});

describe("editing a line keeps its total inside the money column", () => {
  it("refuses with a 400 when the new quantity × the stored unit price would not fit", async () => {
    await expect(receiptService.editLine("r-1", "submitter", 5, { quantity: 100_000 })).rejects.toMatchObject({
      status: 400,
      message: "Quantity × unit price must be at most 21,474,836.47",
    });
    expect(tx.receiptLineItem.update).not.toHaveBeenCalled();
  });

  it("saves an edit whose total fits", async () => {
    await expect(receiptService.editLine("r-1", "submitter", 5, { quantity: 2 })).resolves.toMatchObject({ totalPriceCents: 200_000 });
  });

  it("saves a total of exactly 2,147,483,647 cents", async () => {
    await expect(receiptService.editLine("r-1", "submitter", 5, { unitPrice: 21474836.47 })).resolves.toMatchObject({ totalPriceCents: 2_147_483_647 });
  });

  it("refuses a total one cent over 2,147,483,647 cents", async () => {
    await expect(receiptService.editLine("r-1", "submitter", 5, { quantity: 2, unitPrice: 10737418.24 })).rejects.toMatchObject({
      status: 400,
      message: LINE_COST_MESSAGE,
    });
    expect(tx.receiptLineItem.update).not.toHaveBeenCalled();
  });
});
