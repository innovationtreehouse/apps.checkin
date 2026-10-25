jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());

import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders, resetRtl, router, setSearchParams } from "@/test-helpers/rtl";
import InventoryLogPage, { applySource, parseDelta } from "@checkin/local-inventory/pages/inventoryLog";

const loaded: string[] = [];
let data: Record<string, unknown> = {};
let canSeeReceiving = true;

jest.mock("@checkin/local-inventory/components/api", () => ({
  ...jest.requireActual("@checkin/local-inventory/components/api"),
  useCanSeeReceiving: () => canSeeReceiving,
  useLoad: (path: string | null) => {
    if (path) loaded.push(path);
    const base = path?.split("?")[0] ?? "";
    return { data: base.endsWith("/count") ? { total: 1 } : data[base] ?? [], error: null, reload: jest.fn() };
  },
}));

const receiptDelta = JSON.stringify({
  source: { kind: "receipt", receiptId: "r-9", retailer: "Digi-Key" },
  lineItems: [
    { gtin13: "0000000000017", quantityDelta: 4, isDelayed: false, isProvisional: false, conversionFactor: 1 },
    { gtin13: "0000000000024", quantityDelta: 2, isDelayed: true, isProvisional: false, conversionFactor: 10 },
  ],
});
const donationDelta = JSON.stringify({
  source: { kind: "donation", donationId: "7" },
  lineItems: [{ gtin13: "0000000000031", quantityDelta: 1 }],
});

const APPLIES = [
  { id: 1, status: "failed", receivedAt: "2026-10-01T12:00:00Z", sourceKey: "receipt:r-9", receiptId: "r-9", deltaJson: receiptDelta, failureReason: "stock row locked" },
  { id: 2, status: "applied", receivedAt: "2026-10-02T12:00:00Z", sourceKey: "donation:7", receiptId: null, deltaJson: donationDelta, failureReason: null },
];
const LOG = [
  { id: 5, changedAt: "2026-10-01T12:00:00Z", changeType: "automatic", gtin13: "0000000000017", fieldChanged: "existingQuantity", valueBefore: "1", valueAfter: "5", receiptId: "r-9" },
];

beforeEach(() => {
  resetRtl();
  loaded.length = 0;
  canSeeReceiving = true;
  data = { "/inventory-log": LOG, "/received-inventory-deltas": APPLIES };
});

describe("inventory log gate", () => {
  it("shows a catalog viewer without a receiving role who it is for, and loads nothing", () => {
    canSeeReceiving = false;
    setSearchParams("view=applies");
    renderWithProviders(<InventoryLogPage />);
    expect(screen.getByText("The inventory log is open to inventory managers, Finance and the Board.")).toBeInTheDocument();
    expect(loaded).toEqual([]);
  });
});

describe("inventory log, by part", () => {
  it("lists per-part changes with their receipt, and filters to a receipt when it is clicked", () => {
    renderWithProviders(<InventoryLogPage />);
    expect(loaded).toContain("/inventory-log?page=1&limit=50");
    expect(loaded).toContain("/inventory-log/count");
    fireEvent.click(screen.getByRole("button", { name: "r-9" }));
    expect(router.replace).toHaveBeenCalledWith("/inventory/inventory-log?receiptId=r-9", { scroll: false });
  });

  it("asks the server for one receipt's changes under ?receiptId=", () => {
    setSearchParams("receiptId=r-9");
    renderWithProviders(<InventoryLogPage />);
    expect(loaded).toContain("/inventory-log?page=1&limit=50&receiptId=r-9");
    expect(loaded).toContain("/inventory-log/count?receiptId=r-9");
    fireEvent.click(screen.getByRole("button", { name: "Show every change" }));
    expect(router.replace).toHaveBeenCalledWith("/inventory/inventory-log", { scroll: false });
  });
});

describe("inventory log, by receipt or donation", () => {
  it("shows a failed apply with its reason, its receipt link and its delayed lines", () => {
    setSearchParams("view=applies");
    renderWithProviders(<InventoryLogPage />);
    expect(loaded).toContain("/received-inventory-deltas?page=1&limit=50");
    const failed = screen.getByText("stock row locked").closest("tr") as HTMLElement;
    expect(within(failed).getByText("failed")).toBeInTheDocument();
    expect(within(failed).getByRole("link", { name: "Receipt r-9" })).toHaveAttribute("href", "/receipts/r-9");
    expect(within(failed).getByText("Digi-Key")).toBeInTheDocument();
    expect(within(failed).getByText("1 to receive queue")).toBeInTheDocument();
    expect(screen.getByText("Donation #7")).toBeInTheDocument();
  });

  it("expands an apply into its lines, and shows the raw payload on demand", () => {
    setSearchParams("view=applies");
    renderWithProviders(<InventoryLogPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Show lines" })[0]);
    expect(screen.getByText("Receive queue")).toBeInTheDocument();
    expect(screen.getByText("×10")).toBeInTheDocument();
    expect(screen.queryByText(/"retailer": "Digi-Key"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show raw payload" }));
    expect(screen.getByText(/"retailer": "Digi-Key"/)).toBeInTheDocument();
  });

  it("links an applied receipt to its stock changes, but not a failed one", () => {
    data["/received-inventory-deltas"] = [{ ...APPLIES[0], status: "applied", failureReason: null }];
    setSearchParams("view=applies");
    renderWithProviders(<InventoryLogPage />);
    fireEvent.click(screen.getByRole("button", { name: "Show lines" }));
    fireEvent.click(screen.getByRole("button", { name: "Its stock changes" }));
    expect(router.replace).toHaveBeenCalledWith("/inventory/inventory-log?receiptId=r-9", { scroll: false });
  });

  it("filters to failed applies under ?status=failed", () => {
    setSearchParams("view=applies&status=failed");
    renderWithProviders(<InventoryLogPage />);
    expect(loaded).toContain("/received-inventory-deltas?page=1&limit=50&status=failed");
    expect(loaded).toContain("/received-inventory-deltas/count?status=failed");
  });

  it("puts the status filter in the URL", () => {
    setSearchParams("view=applies");
    renderWithProviders(<InventoryLogPage />);
    fireEvent.click(screen.getByText("Failed"));
    expect(router.replace).toHaveBeenCalledWith("/inventory/inventory-log?view=applies&status=failed", { scroll: false });
  });
});

describe("parseDelta and applySource", () => {
  it("reads the retailer from the source and defaults missing line flags", () => {
    expect(parseDelta(donationDelta).lines).toEqual([
      { gtin13: "0000000000031", quantityDelta: 1, isDelayed: false, isProvisional: false, conversionFactor: 1 },
    ]);
    expect(parseDelta(receiptDelta).retailer).toBe("Digi-Key");
  });

  it("keeps an unparseable payload as raw text with no lines", () => {
    expect(parseDelta("not json")).toEqual({ retailer: null, lines: null, pretty: "not json" });
  });

  it("names the donation from its source key when there is no receipt", () => {
    expect(applySource({ id: 1, status: "applied", receivedAt: "", sourceKey: "donation:7", receiptId: null })).toEqual({ kind: "donation", id: "7" });
    expect(applySource({ id: 1, status: "applied", receivedAt: "" })).toBeNull();
  });
});
