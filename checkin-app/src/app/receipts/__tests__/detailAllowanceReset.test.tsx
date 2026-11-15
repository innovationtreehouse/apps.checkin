import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

let mockRoles = { isFinance: false, isBoard: false };
const mockUserId = 2;
let mockAudit: Array<Record<string, unknown>> = [];
const mockSend = jest.fn<Promise<boolean>, unknown[]>(async () => true);

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
  useLoad: (path: string | null) => ({
    data: path === "/r1" ? receipt : path === "/r1/audit-logs" ? mockAudit : path === null ? null : path.endsWith("/duplicate-group") ? { members: [], dismissed: [] } : [],
    error: null,
    reload: jest.fn(),
  }),
  useRoles: () => mockRoles,
  send: (...args: unknown[]) => mockSend(...args),
}));

const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 7, mimeType: "application/pdf", state: "ocr_failed",
  validationNotes: "Today's automatic reading allowance is used up.", needsReimbursement: false, isInKind: false, financialReviewReasons: [], lineItems: [],
};

const failedRow = (action: string, valueAfter: string, id = 1) => ({ id, action, userId: 7, username: "u", fieldChanged: null, valueBefore: null, valueAfter, changedAt: "2026-10-01T00:00:00Z" });
const USED_UP = failedRow("ocr_failed", "daily limit reached");
const BUTTON = "Reset reading allowance";

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  mockAudit = [USED_UP];
  mockSend.mockClear();
});

const offered = () => {
  render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
  return screen.queryByRole("button", { name: BUTTON }) !== null;
};

describe("Reset reading allowance on a receipt whose reading allowance ran out", () => {
  it.each([
    ["finance", { isFinance: true, isBoard: false }, true],
    ["the Board", { isFinance: false, isBoard: true }, true],
    ["a submitter", { isFinance: false, isBoard: false }, false],
  ] as const)("is offered to %s: %s", (_who, roles, expected) => {
    mockRoles = roles;
    expect(offered()).toBe(expected);
  });

  it("is not offered when the reading failed for another reason", () => {
    mockRoles = { isFinance: true, isBoard: false };
    mockAudit = [failedRow("ocr_failed:data", "unreadable")];
    expect(offered()).toBe(false);
  });

  it("is not offered when a later reading failed for another reason", () => {
    mockRoles = { isFinance: true, isBoard: false };
    mockAudit = [USED_UP, failedRow("ocr_failed:data", "unreadable", 2)];
    expect(offered()).toBe(false);
  });

  it("resets the uploader's allowance with the reason typed", async () => {
    mockRoles = { isFinance: true, isBoard: false };
    render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: BUTTON }));
    const dialog = within(await screen.findByRole("dialog"));
    const confirm = dialog.getByRole("button", { name: "Reset allowance" });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByLabelText(/Reason/),{ target: { value: "statements re-sent" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith("/allowance/7/reset", "POST", { reason: "statements re-sent" }, expect.any(String), expect.any(String)),
    );
  });
});
