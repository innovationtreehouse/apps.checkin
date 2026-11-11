import { render, screen, within } from "@testing-library/react";
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
  { ...row("f", "Files", "rejected"), validationNotes: "Personal purchase", rejectionUnacknowledged: true },
  { ...row("i", "Irons", "rejected"), validationNotes: "Seen already", rejectionUnacknowledged: false },
  { ...row("g", "Glue", "receipt_finalized"), purchaseOutcome: { receiving: "received", money: { status: "complete", notes: [] }, gift: null } },
  { ...row("h", "Hinges", "receipt_finalized"), purchaseOutcome: { receiving: "received", money: { status: "line_rejected", notes: ["Not a program cost"] }, gift: null } },
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

  it("shows finance's reason on a rejected receipt", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Files")).getByText("Reason: Personal purchase")).toBeInTheDocument();
  });

  it("flags a rejected receipt until its uploader acknowledges it", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Files")).getByText("Needs you")).toBeInTheDocument();
    expect(within(rowOf("Irons")).queryByText("Needs you")).not.toBeInTheDocument();
    expect(within(rowOf("Irons")).getByText("Reason: Seen already")).toBeInTheDocument();
  });

  it("shows where a finalized receipt's purchase stands, with an approver's note on a rejected line", () => {
    render(<MantineProvider><MyReceiptsPage /></MantineProvider>);
    expect(within(rowOf("Glue")).getByText("Complete")).toBeInTheDocument();
    expect(within(rowOf("Hinges")).getByText("Line rejected: Not a program cost")).toBeInTheDocument();
    expect(within(rowOf("Drills")).queryByText(/Received|Complete/)).not.toBeInTheDocument();
  });

});
