import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  useBuckets: () => [],
  paged: (path: string, page: number) => `${path}?page=${page}`,
  PAGE_SIZE: 50,
  send: jest.fn(),
}));

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

interface LineOpts { id: number; description: string; manualQbAccount?: string | null; nonInventory?: boolean }
interface HoldOpts { lineItemId: number; reason: string; matchedRows?: unknown[]; status?: string }

function renderWith(lines: LineOpts[], holds: HoldOpts[]) {
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, taxCents: 0, shippingCents: 0, discountCents: 0,
      currency: "USD", submittedAt: "2026-10-01T00:00:00Z", state: "qb_on_hold", needsReimbursement: false, backfill: false,
      lineItems: lines.map((l, i) => ({
        lineNumber: i + 1, partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 500, totalPriceCents: 500,
        gtin13: null, isDelayed: false, isCapital: false, depreciationYears: null, capitalOwnerId: null, manualQbAccount: null, ...l,
      })),
      approvals: [],
      holds: holds.map((h, i) => ({ id: 100 + i, status: "PENDING", ...h, matchedRows: JSON.stringify(h.matchedRows ?? []) })),
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
    "/qb-accounts": [
      { id: 1, name: "Supplies", qbAccount: "4000" },
      { id: 2, name: "Tools", qbAccount: "4100" },
    ],
  };
  render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
}

const resubmit = () => screen.getByRole("button", { name: "Resubmit" });

describe("Account holds panel", () => {
  it("words each hold reason", () => {
    renderWith(
      [
        { id: 1, description: "Cable" },
        { id: 2, description: "Bolt" },
        { id: 3, description: "Tape" },
        { id: 4, description: "Pizza", nonInventory: true },
      ],
      [
        { lineItemId: 1, reason: "NO_MATCH" },
        { lineItemId: 2, reason: "MULTIPLE_MATCHES" },
        { lineItemId: 3, reason: "NO_PART_NUMBER" },
        { lineItemId: 4, reason: "NON_INVENTORY" },
      ],
    );
    expect(screen.getByText("No account rule matches")).toBeInTheDocument();
    expect(screen.getByText("Several account rules match")).toBeInTheDocument();
    expect(screen.getByText("No part number; pick an account")).toBeInTheDocument();
    expect(screen.getByText("Not stock; pick an account")).toBeInTheDocument();
    expect(screen.queryByText("NO_MATCH")).not.toBeInTheDocument();
  });

  it("shows what a no-match line was looked up by", () => {
    renderWith(
      [{ id: 1, description: "Cable" }],
      [{ lineItemId: 1, reason: "NO_MATCH", matchedRows: [{ _lookupContext: { category: "Hardware", subcategory: "Cables", partNumber: "0000000000017", isDelayed: false, isCapital: false } }] }],
    );
    expect(screen.getByText("Looked up by category Hardware, subcategory Cables, part number 0000000000017")).toBeInTheDocument();
  });

  it("lists a several-match line's rules with their account names, not JSON", () => {
    renderWith(
      [{ id: 1, description: "Cable" }],
      [{
        lineItemId: 1, reason: "MULTIPLE_MATCHES",
        matchedRows: [
          { id: 7, orgId: "o", category: "*", subcategory: "*", partNumber: "*", isDelayed: null, isCapital: null, qbAccount: "4000" },
          { id: 8, orgId: "o", category: "Hardware", subcategory: "*", partNumber: "*", isDelayed: null, isCapital: null, qbAccount: "4100" },
        ],
      }],
    );
    expect(screen.getByText("Rule * / * / * → Supplies (4000)")).toBeInTheDocument();
    expect(screen.getByText("Rule Hardware / * / * → Tools (4100)")).toBeInTheDocument();
    expect(screen.queryByText(/qbAccount/)).not.toBeInTheDocument();
  });

  it("disables Resubmit, saying why, while a held line has no account", () => {
    renderWith(
      [{ id: 1, description: "Cable", manualQbAccount: "4000" }, { id: 2, description: "Tape" }],
      [{ lineItemId: 1, reason: "NO_MATCH" }, { lineItemId: 2, reason: "NO_PART_NUMBER" }],
    );
    expect(resubmit()).toBeDisabled();
    expect(screen.getByText("1 held line has no account yet")).toBeInTheDocument();
  });

  it("enables Resubmit once every held line has an account", () => {
    renderWith(
      [{ id: 1, description: "Cable", manualQbAccount: "4000" }, { id: 2, description: "Tape", manualQbAccount: "4100" }],
      [{ lineItemId: 1, reason: "NO_MATCH" }, { lineItemId: 2, reason: "NO_PART_NUMBER" }],
    );
    expect(resubmit()).toBeEnabled();
    expect(screen.queryByText(/no account yet/)).not.toBeInTheDocument();
  });

  it("hides the panel when no hold is pending", () => {
    renderWith([{ id: 1, description: "Cable" }], [{ lineItemId: 1, reason: "NO_MATCH", status: "RESOLVED" }]);
    expect(screen.queryByText("Account holds")).not.toBeInTheDocument();
  });
});
