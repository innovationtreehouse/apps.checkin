/** Associate's GTIN gate: only a well-formed GTIN-13 naming an approved, non-archived catalog item reaches the line. */
import { NotWiredError, ServiceError } from "@checkin/component-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogReader, CatalogSubmissions } from "../../contract";
import { configure } from "../helpers/setup";

const { loadEditableLine, updateEditableLine } = vi.hoisted(() => ({ loadEditableLine: vi.fn(), updateEditableLine: vi.fn() }));

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../lib/audit", () => ({ insertAuditEvent: vi.fn() }));
vi.mock("../../lib/auto-proceed", () => ({ tryAutoProceedApply: vi.fn() }));
vi.mock("../../services/receiptLookup", () => ({
  loadEditableLine,
  updateEditableLine,
}));

const { lineItemService } = await import("../../services/lineItemService");

const ACTIVE = "0011111111110";
const ARCHIVED = "0033333333330";

/** A NotWiredError from a second copy of component-kit, as a built app can load: the kit's brand and name, another class. */
const foreignNotWired = (port: string) =>
  Object.assign(new Error(`${port} is not wired`), { name: "NotWiredError", kind: "settings", [Symbol.for("@checkin/component-kit/KindedError")]: true, [Symbol.for("@checkin/component-kit/NotWiredError")]: true });
const noRef = { exists: false, gtin13: null, id: null, conversionFactor: 1, conversionVersion: 1 };

const getActiveItem = vi.fn<CatalogReader["getActiveItem"]>();
const catalogReader: CatalogReader = {
  lookupItems: async () => [],
  checkReferences: async () => ({ mfr_part: noRef, retailer_part: noRef, mfr_desc: noRef, wouldCreateNewReference: false }),
  getActiveItem,
};
const catalogSubmissions: CatalogSubmissions = {
  proposeItemReference: async () => ({ id: 1 }),
  reportConflict: async () => ({ id: 2 }),
  allocateProvisionalGtin: async () => "0200002700001",
  proposeProvisionalItem: async () => undefined,
};

const editableLine = (lineStatus: object = { id: 2 }) => ({
  received: { id: 1, orgId: "org", receiptId: "r-1" },
  lineStatus,
  receipt: { vendorName: "Hardware Co" },
  lineItem: { receiptLineItemId: 1, partNumber: "PN-1", description: "Hex bolt" },
});

beforeEach(() => {
  vi.clearAllMocks();
  loadEditableLine.mockResolvedValue(editableLine());
  updateEditableLine.mockResolvedValue(true);
  // The catalog port answers null for an archived GTIN, as it does for an unknown one.
  getActiveItem.mockImplementation(async (gtin13) => (gtin13 === ACTIVE ? { gtin13, name: "Cordless Drill" } : null));
  configure({ catalogReader, catalogSubmissions });
});

describe("associateGtin GTIN check", () => {
  it.each([
    ["malformed", "12345"],
    ["non-digit", "001111111111X"],
    ["wrong check digit", "0011111111113"],
  ])("400 for a %s GTIN, before the catalog is asked", async (_case, gtin13) => {
    await expect(lineItemService.associateGtin(1, 2, { gtin13 })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(`"${gtin13}" is not a GTIN-13`),
    });
    expect(getActiveItem).not.toHaveBeenCalled();
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("404 for a GTIN no catalog item has", async () => {
    await expect(lineItemService.associateGtin(1, 2, { gtin13: "0044444444440" })).rejects.toMatchObject({
      status: 404,
      message: "No catalog item has Part ID 0044444444440",
    });
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("404 for an archived item", async () => {
    await expect(lineItemService.associateGtin(1, 2, { gtin13: ARCHIVED })).rejects.toMatchObject({ status: 404 });
    expect(getActiveItem).toHaveBeenCalledWith(ARCHIVED);
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("503 \"No catalog is connected\" when the catalog is unbound, never treating it as not found", async () => {
    getActiveItem.mockRejectedValue(new NotWiredError("CatalogReader.getActiveItem"));
    await expect(lineItemService.associateGtin(1, 2, { gtin13: ACTIVE })).rejects.toMatchObject({ status: 503, message: "No catalog is connected" });
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("503 \"No catalog is connected\" for an unbound catalog from another copy of the kit", async () => {
    getActiveItem.mockRejectedValue(foreignNotWired("CatalogReader.getActiveItem"));
    await expect(lineItemService.associateGtin(1, 2, { gtin13: ACTIVE })).rejects.toMatchObject({ status: 503, message: "No catalog is connected" });
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("503 naming who fixes it when the catalog database does not exist, never \"not connected\"", async () => {
    getActiveItem.mockRejectedValue(Object.assign(new Error("Database does not exist"), { code: "P1003" }));
    await expect(lineItemService.associateGtin(1, 2, { gtin13: ACTIVE })).rejects.toMatchObject({ status: 503, message: "The catalog database does not exist; the infra operator checks its settings" });
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("502 when the catalog read fails, never treating it as not found", async () => {
    getActiveItem.mockRejectedValue(new Error("catalog down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(lineItemService.associateGtin(1, 2, { gtin13: ACTIVE })).rejects.toMatchObject({
      status: 502,
      message: "The catalog couldn't be reached; try again",
    });
    expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "catalog down" }));
    logged.mockRestore();
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("502 with the catalog's own message for an expected catalog failure", async () => {
    getActiveItem.mockRejectedValue(new ServiceError(409, "Proposal was already reviewed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(lineItemService.associateGtin(1, 2, { gtin13: ACTIVE })).rejects.toMatchObject({
      status: 502,
      message: "Proposal was already reviewed",
    });
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("records a valid, active item's GTIN on the line", async () => {
    await lineItemService.associateGtin(1, 2, { gtin13: ACTIVE });
    expect(updateEditableLine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recognitionStatus: "recognized", assignedGtin13: ACTIVE }),
      expect.objectContaining({ eventType: "line_associated" }),
      expect.any(Function),
    );
  });
});

describe("associateGtin repeat", () => {
  const associated = { id: 2, recognitionStatus: "recognized", assignedGtin13: ACTIVE, conversionFactor: 4, conversionVersion: 3 };
  const proposeItemReference = vi.fn<CatalogSubmissions["proposeItemReference"]>(async () => ({ id: 1 }));

  beforeEach(() => configure({ catalogReader, catalogSubmissions: { ...catalogSubmissions, proposeItemReference } }));

  it("does nothing when the line already has the same GTIN and factor", async () => {
    loadEditableLine.mockResolvedValue(editableLine(associated));
    await lineItemService.associateGtin(1, 2, { gtin13: ACTIVE, conversionFactor: 4 });
    expect(getActiveItem).not.toHaveBeenCalled();
    expect(proposeItemReference).not.toHaveBeenCalled();
    expect(updateEditableLine).not.toHaveBeenCalled();
  });

  it("writes the line, proposes and logs when the factor changes", async () => {
    loadEditableLine.mockResolvedValue(editableLine(associated));
    await lineItemService.associateGtin(1, 2, { gtin13: ACTIVE, conversionFactor: 6 });
    expect(proposeItemReference).toHaveBeenCalledOnce();
    expect(updateEditableLine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversionFactor: 6, conversionVersion: 1 }),
      expect.objectContaining({ eventType: "line_associated" }),
      expect.any(Function),
    );
  });

  it("re-checks the locked row, skipping the write only for the same GTIN and factor", async () => {
    await lineItemService.associateGtin(1, 2, { gtin13: ACTIVE, conversionFactor: 4 });
    const unchanged = updateEditableLine.mock.calls[0][3] as (row: typeof associated) => boolean;
    expect(unchanged(associated)).toBe(true);
    expect(unchanged({ ...associated, conversionFactor: 6 })).toBe(false);
    expect(unchanged({ ...associated, assignedGtin13: "0000000000024" })).toBe(false);
    expect(unchanged({ ...associated, recognitionStatus: "provisional" })).toBe(false);
  });
});
