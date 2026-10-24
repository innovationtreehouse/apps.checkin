import { fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MyReceiptsPage from "@checkin/receipt/pages/mine";

const row = (id: string, retailer: string, state: string) => ({
  id, uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer, receiptDate: "2026-10-01",
  receiptTotalCents: 1000, state, needsReimbursement: false, isInKind: false,
});
const rows = [
  row("a", "Acme", "validation_failed"),
  row("b", "Bolt Co", "financial_review"),
  row("c", "Cogs", "submitter_review"),
  row("d", "Drills", "receipt_finalized"),
  { ...row("e", "Epoxy", "submitter_review"), needsReimbursement: true, reimburseePersonId: 2 },
];
let mockConfirmations: unknown[] = [];
const mockSend = jest.fn<Promise<boolean>, unknown[]>();

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string) => ({ data: path === "/confirmations" ? mockConfirmations : rows, error: null, reload: jest.fn() }),
  send: (...args: unknown[]) => mockSend(...args),
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

describe("My receipts", () => {
  it("flags the rows that wait on their uploader", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Acme")).getByText("Needs you")).toBeInTheDocument();
    expect(within(rowOf("Cogs")).getByText("Needs you")).toBeInTheDocument();
    expect(within(rowOf("Bolt Co")).queryByText("Needs you")).not.toBeInTheDocument();
    expect(within(rowOf("Drills")).queryByText("Needs you")).not.toBeInTheDocument();
  });

  it("does not flag a reimbursement for someone else, which the person reimbursed confirms", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Epoxy")).queryByText("Needs you")).not.toBeInTheDocument();
  });

  it("lists reimbursements waiting for the caller's confirmation, with what finance changed, and confirms one", () => {
    mockConfirmations = [{
      id: "f", state: "receipt_finalized", retailer: "Fasteners Inc", receiptDate: "2026-10-01", currency: "USD", shippingCents: 0, taxCents: 0,
      discountCents: 0, receiptTotalCents: 1000, onBehalf: true, changedFields: ["reimbursee"],
      lineItems: [{ id: 1, lineNumber: 1, description: "Hinge", quantity: 2, totalPriceCents: 1000, isDelayed: false }],
    }];
    mockSend.mockResolvedValue(true);
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(screen.getByText("Receipts to confirm")).toBeInTheDocument();
    expect(screen.getByText("For a person with no account")).toBeInTheDocument();
    expect(screen.getByText(/Finance changed this receipt; confirm it again\. Changed: reimbursee\./)).toBeInTheDocument();
    expect(screen.getByText("Hinge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "These lines and amounts are right" }));
    expect(mockSend).toHaveBeenCalledWith("/f/confirmation", "POST", {}, "Confirmed", "Couldn't confirm this receipt");
    mockConfirmations = [];
  });
});
