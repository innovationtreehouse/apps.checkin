import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

let mockUserId = 1;
let mockReceipt: Record<string, unknown> = {};
const mockSend = jest.fn<Promise<boolean>, unknown[]>();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  usePathname: () => "/receipts/r1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: mockUserId, ageBand: "adult" } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({ __esModule: true, default: () => <figure /> }));
jest.mock("@checkin/receipt/components/ReceiptEditor", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => ({ data: path === "/r1" ? mockReceipt : path === null ? null : [], error: null, reload: jest.fn() }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  send: (...args: unknown[]) => mockSend(...args),
}));

const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: "2026-10-01",
  receiptTotalCents: 1000, taxCents: 0, shippingCents: 0, discountCents: 0, mimeType: "application/pdf",
  needsReimbursement: false, isInKind: false, financialReviewReasons: [], lineItems: [],
};

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  mockUserId = 1;
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
});

const wrap = () => render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);

describe("a rejected receipt's detail page", () => {
  it("shows the uploader finance's reason and acknowledges it with Got it", () => {
    mockReceipt = { ...receipt, state: "rejected", validationNotes: "Personal purchase", rejectionUnacknowledged: true };
    wrap();
    expect(screen.getByText("Personal purchase")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(mockSend).toHaveBeenCalledWith("/r1/acknowledge-rejection", "POST", {}, "Acknowledged", "Couldn't acknowledge this rejection");
  });

  it("offers no Got it once acknowledged, or to anyone but the uploader", () => {
    mockReceipt = { ...receipt, state: "rejected", validationNotes: "Personal purchase", rejectionUnacknowledged: false };
    const { unmount } = wrap();
    expect(screen.queryByRole("button", { name: "Got it" })).not.toBeInTheDocument();
    unmount();
    mockUserId = 2;
    mockReceipt = { ...receipt, state: "rejected", validationNotes: "Personal purchase", rejectionUnacknowledged: true };
    wrap();
    expect(screen.queryByRole("button", { name: "Got it" })).not.toBeInTheDocument();
  });
});

describe("a finalized receipt's detail page", () => {
  it("shows each step of the purchase, with the approver's note on a rejected line", () => {
    mockReceipt = {
      ...receipt,
      state: "receipt_finalized",
      purchaseOutcome: { receiving: "received", money: { status: "line_rejected", notes: ["Not a program cost"] }, gift: null },
    };
    wrap();
    expect(screen.getByText("What happened next")).toBeInTheDocument();
    expect(screen.getByText("Received")).toBeInTheDocument();
    expect(screen.getByText("Line rejected")).toBeInTheDocument();
    expect(screen.getByText("Not a program cost")).toBeInTheDocument();
  });
});
