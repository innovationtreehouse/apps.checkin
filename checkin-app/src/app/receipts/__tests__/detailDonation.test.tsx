import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

let mockUserId = 1;
let mockReceipt: Record<string, unknown> = {};

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
  send: jest.fn(),
}));

const { send: sendMock } = jest.requireMock<{ send: jest.Mock<Promise<boolean>, [string, string, unknown, string, string]> }>(
  "@checkin/receipt/components/api",
);

const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: "2026-10-01",
  receiptTotalCents: 1000, taxCents: 0, shippingCents: 0, discountCents: 0, mimeType: "application/pdf",
  state: "submitter_review", needsReimbursement: false, isInKind: false, financialReviewReasons: [], lineItems: [],
};

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  jest.clearAllMocks();
  sendMock.mockResolvedValue(true);
  mockUserId = 1;
  mockReceipt = receipt;
});

const renderPage = () => render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
const donationBox = () => screen.queryByRole("checkbox", { name: /This is a donation/ });
const saveDonation = () => screen.getByRole("button", { name: "Save donation" });

describe("marking a receipt as a donation after upload", () => {
  it.each(["ocr_failed", "validation_failed", "submitter_review"])("offers the uploader the donation controls in %s", (state) => {
    mockReceipt = { ...receipt, state };
    renderPage();
    expect(donationBox()).not.toBeNull();
  });

  it.each(["financial_review", "receipt_finalized", "duplicate_flagged"])("offers no donation controls in %s", (state) => {
    mockReceipt = { ...receipt, state };
    renderPage();
    expect(donationBox()).toBeNull();
  });

  it("offers no donation controls to someone other than the uploader", () => {
    mockUserId = 2;
    renderPage();
    expect(donationBox()).toBeNull();
  });

  it("marks the uploader as the donor by default", async () => {
    renderPage();
    fireEvent.click(donationBox()!);
    fireEvent.click(saveDonation());
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(sendMock.mock.calls[0].slice(0, 3)).toEqual(["/r1/in-kind", "PUT", { isInKind: true, donor: { self: true } }]);
  });

  it("sends a named donor, and holds Save until the donor's name is filled in", async () => {
    renderPage();
    fireEvent.click(donationBox()!);
    fireEvent.click(screen.getByText("Someone else donated"));
    expect(saveDonation()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Donor first name", { exact: false }), { target: { value: " Ada " } });
    fireEvent.change(screen.getByLabelText("Donor last name", { exact: false }), { target: { value: "   " } });
    expect(saveDonation()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Donor last name", { exact: false }), { target: { value: "Lovelace" } });
    fireEvent.click(saveDonation());
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(sendMock.mock.calls[0][2]).toEqual({ isInKind: true, donor: { firstName: "Ada", lastName: "Lovelace", companyName: null } });
  });

  it("holds Save after a save that keeps the donation mark on", async () => {
    mockReceipt = { ...receipt, isInKind: true };
    renderPage();
    fireEvent.click(screen.getByText("Someone else donated"));
    fireEvent.change(screen.getByLabelText("Donor first name", { exact: false }), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Donor last name", { exact: false }), { target: { value: "Lovelace" } });
    fireEvent.click(saveDonation());
    await waitFor(() => expect(saveDonation()).toBeDisabled());
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("clears the mark on a donation", async () => {
    mockReceipt = { ...receipt, isInKind: true };
    renderPage();
    expect(donationBox()).toBeChecked();
    expect(saveDonation()).toBeDisabled();
    fireEvent.click(donationBox()!);
    fireEvent.click(saveDonation());
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(sendMock.mock.calls[0][2]).toEqual({ isInKind: false });
  });

  it("keeps the toggle off, with a hint, while the receipt is marked for reimbursement", () => {
    mockReceipt = { ...receipt, needsReimbursement: true };
    renderPage();
    expect(donationBox()).toBeDisabled();
    expect(screen.getByText(/never reimbursed/)).toBeInTheDocument();
  });
});
