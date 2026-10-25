import { render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MyReceiptsPage from "@checkin/receipt/pages/mine";

const row = (retailer: string, extra: Record<string, string>) => ({
  id: retailer.toLowerCase(), uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer, receiptDate: "2026-10-01",
  receiptTotalCents: 1000, state: "discarded", needsReimbursement: false, isInKind: false, ...extra,
});
const flagged = "2026-10-02T00:00:00Z";
const rows = [
  row("Acme", { duplicateFlaggedAt: flagged, duplicateSuspectReceiptId: "orig-1" }),
  row("Bolt", { duplicateFlaggedAt: flagged }),
  row("Cogs", { duplicateFlaggedAt: flagged, duplicateFlagClearedAt: "2026-10-03T00:00:00Z" }),
  row("Dyna", {}),
];

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: () => ({ data: rows, error: null, reload: jest.fn() }),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const rowOf = (retailer: string) => screen.getByText(retailer).closest("tr") as HTMLElement;

describe("A discarded receipt's state on My receipts", () => {
  it("says a receipt discarded while flagged was discarded as a duplicate, linking its suspect when the row carries it", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Acme")).getByText(/Discarded as a duplicate of/)).toBeInTheDocument();
    expect(within(rowOf("Acme")).getByRole("link", { name: "another receipt" })).toHaveAttribute("href", "/receipts/orig-1");
    expect(within(rowOf("Bolt")).getByText("Discarded as a duplicate")).toBeInTheDocument();
    expect(within(rowOf("Bolt")).queryByRole("link", { name: "another receipt" })).not.toBeInTheDocument();
  });

  it("keeps the plain label for a cleared flag and for a receipt never flagged", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Cogs")).getByText("Discarded")).toBeInTheDocument();
    expect(within(rowOf("Dyna")).getByText("Discarded")).toBeInTheDocument();
  });
});
