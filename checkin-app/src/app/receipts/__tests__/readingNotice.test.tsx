import { act, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

const mockReload = jest.fn();
let mockState = "ocr_queued";

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  usePathname: () => "/receipts/r1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 7, ageBand: "adult" } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn() } }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({ __esModule: true, default: () => <figure /> }));
jest.mock("@checkin/receipt/components/ReceiptEditor", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => ({
    data: path === "/r1" ? { ...receipt, state: mockState } : path === null ? null : path.endsWith("/duplicate-group") ? { members: [], dismissed: [] } : [],
    error: null,
    reload: mockReload,
  }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
}));

const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 7, mimeType: "application/pdf",
  validationNotes: null, needsReimbursement: false, isInKind: false, financialReviewReasons: [], lineItems: [],
};

const EVERY_MS = 3_000;
const FOR_MS = 3 * 60_000;

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  jest.useFakeTimers();
  mockReload.mockClear();
  mockState = "ocr_queued";
});
afterEach(() => jest.useRealTimers());

const page = () => render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);

describe("a receipt waiting to be read", () => {
  it.each([
    ["ocr_queued", "Saved. Waiting to be read."],
    ["auto_upload", "Saved. Reading it now."],
  ])("in %s says %s and reloads every 3 seconds", (state, text) => {
    mockState = state;
    page();
    expect(screen.getByText(text)).toBeTruthy();
    const before = mockReload.mock.calls.length;
    act(() => jest.advanceTimersByTime(EVERY_MS * 3));
    expect(mockReload.mock.calls.length - before).toBe(3);
  });

  it("stops reloading after 3 minutes and says the page updates on reload", () => {
    page();
    act(() => jest.advanceTimersByTime(FOR_MS + EVERY_MS));
    expect(screen.getByText("Still reading. This page updates when you reload it.")).toBeTruthy();
    const stopped = mockReload.mock.calls.length;
    act(() => jest.advanceTimersByTime(EVERY_MS * 5));
    expect(mockReload.mock.calls.length).toBe(stopped);
  });

  it("shows no notice and polls nothing once the reading has landed", () => {
    mockState = "submitter_review";
    page();
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    act(() => jest.advanceTimersByTime(EVERY_MS * 3));
    expect(mockReload).not.toHaveBeenCalled();
  });
});
