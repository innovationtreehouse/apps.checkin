import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

let mockRoles = { isFinance: false, isBoard: false };
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
  useRoles: () => mockRoles,
  send: jest.fn(),
}));

const receipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: "2026-10-01",
  receiptTotalCents: 1000, taxCents: 0, shippingCents: 0, discountCents: 0, mimeType: "application/pdf",
  state: "financial_review", needsReimbursement: false, isInKind: false, financialReviewReasons: [], lineItems: [],
};

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  mockReceipt = receipt;
});

const shown = () => {
  render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
  return {
    discard: screen.queryByRole("button", { name: "Discard" }) !== null,
    reject: screen.queryByRole("button", { name: "Reject" }) !== null,
  };
};

describe("who sees Discard and Reject on an open receipt", () => {
  it.each<[string, { isFinance: boolean; isBoard: boolean }, number, { discard: boolean; reject: boolean }]>([
    ["the uploader", { isFinance: false, isBoard: false }, 1, { discard: true, reject: false }],
    ["finance on someone else's receipt", { isFinance: true, isBoard: false }, 2, { discard: false, reject: true }],
    ["finance on their own receipt", { isFinance: true, isBoard: false }, 1, { discard: true, reject: false }],
    ["the Board on someone else's receipt", { isFinance: false, isBoard: true }, 2, { discard: false, reject: false }],
    ["the Board on their own receipt", { isFinance: false, isBoard: true }, 1, { discard: true, reject: false }],
  ])("%s", (_who, roles, userId, expected) => {
    mockRoles = roles;
    mockUserId = userId;
    expect(shown()).toEqual(expected);
  });

  it.each(["uploaded", "auto_upload", "ocr_failed", "validation_failed", "submitter_review", "flow_error"])(
    "offers finance Reject on someone else's receipt in %s",
    (state) => {
      mockRoles = { isFinance: true, isBoard: false };
      mockUserId = 2;
      mockReceipt = { ...receipt, state };
      expect(shown().reject).toBe(true);
    },
  );

  it.each(["receipt_finalized", "discarded", "rejected"])("offers neither once the receipt is %s", (state) => {
    mockRoles = { isFinance: true, isBoard: false };
    mockUserId = 1;
    mockReceipt = { ...receipt, state };
    expect(shown()).toEqual({ discard: false, reject: false });
  });
});

describe("who sees Ignore this file", () => {
  it.each([["discarded", true], ["rejected", true], ["financial_review", false]] as const)("finance on a %s receipt: %s", (state, offered) => {
    mockRoles = { isFinance: true, isBoard: false };
    mockUserId = 2;
    mockReceipt = { ...receipt, state };
    render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
    expect(screen.queryByRole("button", { name: "Ignore this file from now on" }) !== null).toBe(offered);
  });
});
