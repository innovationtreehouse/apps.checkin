import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ConfirmReceiptsPage from "@checkin/receipt/pages/confirm";

let mockConfirmations: unknown[] = [];
const mockSend = jest.fn<Promise<boolean>, unknown[]>();

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: () => ({ data: mockConfirmations, error: null, reload: jest.fn() }),
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
