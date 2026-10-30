import { fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ConfirmReceiptsPage from "@checkin/receipt/pages/confirm";

let mockConfirmations: unknown[] = [];
let mockReimbursed: unknown[] = [];
const mockSend = jest.fn<Promise<boolean>, unknown[]>();

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string) => ({ data: path === "/reimbursements" ? mockReimbursed : mockConfirmations, error: null, reload: jest.fn() }),
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

const confirmation = (over: Record<string, unknown> = {}) => ({
  id: "f", state: "receipt_finalized", retailer: "Fasteners Inc", receiptDate: "2026-10-01", currency: "USD", shippingCents: 0, taxCents: 0,
  discountCents: 0, receiptTotalCents: 1000, onBehalf: false, changedFields: [],
  lineItems: [{ id: 1, lineNumber: 1, description: "Hinge", quantity: 2, totalPriceCents: 1000, isDelayed: false }],
  ...over,
});

beforeEach(() => {
  mockReimbursed = [];
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
});

const wrap = () => render(<MantineProvider><ConfirmReceiptsPage /></MantineProvider>);

describe("Receipts to confirm", () => {
  it("says so when nothing waits", () => {
    mockConfirmations = [];
    wrap();
    expect(screen.getByText("Nothing waits for your confirmation.")).toBeInTheDocument();
  });

  it("shows the person reimbursed the lines and amounts, and confirms with no reason", () => {
    mockConfirmations = [confirmation()];
    wrap();
    expect(screen.getByText("Hinge")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Why the Board confirms/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "These lines and amounts are right" }));
    expect(mockSend).toHaveBeenCalledWith("/f/confirmation", "POST", {}, "Confirmed", "Couldn't confirm this receipt");
  });

  it("names what finance changed, and asks a Board member for the reason before confirming on someone's behalf", () => {
    mockConfirmations = [confirmation({ onBehalf: true, changedFields: ["reimbursee", "currency"] })];
    wrap();
    expect(screen.getByText("For a person with no account")).toBeInTheDocument();
    expect(screen.getByText(/Finance changed this receipt; confirm it again\. Changed: reimbursee, currency\./)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "These lines and amounts are right" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Why the Board confirms on their behalf/), { target: { value: "No email address" } });
    fireEvent.click(confirm);
    expect(mockSend).toHaveBeenCalledWith("/f/confirmation", "POST", { reason: "No email address" }, "Confirmed", "Couldn't confirm this receipt");
  });
});

describe("Reimbursements others uploaded for you", () => {
  const reimbursed = (over: Record<string, unknown> = {}) => ({
    id: "g", state: "receipt_finalized", retailer: "Glue Depot", receiptDate: "2026-10-02", receiptTotalCents: 2500,
    rejectionReason: null, reimbursement: { paidOn: null }, purchaseOutcome: null, ...over,
  });
  const rowOf = (retailer: string) => screen.getByText(retailer).closest("tr") as HTMLElement;

  it("shows the person reimbursed an approver's rejection of a line, with its note", () => {
    mockConfirmations = [];
    mockReimbursed = [reimbursed({ purchaseOutcome: { receiving: "received", money: { status: "line_rejected", notes: ["Not a program cost"] }, gift: null } })];
    wrap();
    expect(within(rowOf("Glue Depot")).getByText("Line rejected: Not a program cost")).toBeInTheDocument();
    expect(within(rowOf("Glue Depot")).getByText("Not yet paid")).toBeInTheDocument();
  });

  it("shows finance's reason on a rejected receipt", () => {
    mockConfirmations = [];
    mockReimbursed = [reimbursed({ state: "rejected", rejectionReason: "Duplicate of a card charge" })];
    wrap();
    expect(within(rowOf("Glue Depot")).getByText("Rejected: Duplicate of a card charge")).toBeInTheDocument();
  });

  it("says when nobody else has uploaded a reimbursement for the caller", () => {
    mockConfirmations = [];
    wrap();
    expect(screen.getByText("No one else has uploaded a receipt reimbursing you.")).toBeInTheDocument();
  });
});
