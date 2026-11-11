import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import QbAccountsPage from "@checkin/expense/pages/qbAccounts";

const LIVE = "/api/books-map/quickbooks-accounts";
const mockSend = jest.fn<Promise<boolean>, unknown[]>(async () => true);
let mockLoads: Record<string, { data: unknown; error: string | null }> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ ...(path ? mockLoads[path] : null) ?? { data: null, error: null }, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  send: (...args: unknown[]) => mockSend(...args),
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

const liveAccounts = [
  { id: "8001", name: "Checking", accountType: "Bank", active: true },
  { id: "8002", name: "Sales:Shop sales", accountType: "Income", active: true },
  { id: "8004", name: "Merchant fees", accountType: "Expense", active: true },
  { id: "8006", name: "Shop supplies", accountType: "Expense", active: true },
  { id: "8007", name: "Interest paid", accountType: "Other Expense", active: true },
  { id: "8008", name: "Kit materials", accountType: "Cost of Goods Sold", active: true },
  { id: "8009", name: "Old supplies", accountType: "Expense", active: false },
  { id: "8010", name: "Equipment", accountType: "Fixed Asset", active: true },
];

function renderPage(live: { data: unknown; error: string | null }, saved: unknown[] = []) {
  mockLoads = { "/qb-accounts": { data: saved, error: null }, [LIVE]: live };
  render(<MantineProvider><QbAccountsPage /></MantineProvider>);
}

describe("QuickBooks accounts page", () => {
  beforeEach(() => mockSend.mockClear());

  it("offers only active Expense, Other Expense, Cost of Goods Sold and Fixed Asset accounts from QuickBooks", () => {
    renderPage({ data: liveAccounts, error: null });
    fireEvent.click(screen.getByRole("textbox", { name: "QuickBooks account" }));
    const offered = screen.getAllByRole("option").map((o) => o.textContent);
    expect(offered).toEqual(["Merchant fees", "Shop supplies", "Interest paid", "Kit materials", "Equipment"]);
  });

  it("saves the picked account's QuickBooks name and id", () => {
    renderPage({ data: liveAccounts, error: null });
    fireEvent.click(screen.getByRole("textbox", { name: "QuickBooks account" }));
    fireEvent.click(screen.getByRole("option", { name: "Shop supplies" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(mockSend).toHaveBeenCalledWith("/qb-accounts", "POST", { name: "Shop supplies", qbAccount: "8006" }, "Account added");
  });

  it("shows each saved row's QuickBooks name and marks an id QuickBooks no longer has", () => {
    renderPage({ data: liveAccounts, error: null }, [
      { id: 1, name: "Supplies", qbAccount: "8006" },
      { id: 2, name: "Gone", qbAccount: "8099" },
    ]);
    expect(screen.getByRole("row", { name: /Supplies/ })).toHaveTextContent("Shop supplies");
    expect(screen.getByRole("row", { name: /Gone/ })).toHaveTextContent("Not in QuickBooks");
  });

  it("shows the load error and no way to type an id when QuickBooks can't be read", () => {
    renderPage({ data: null, error: "QuickBooks is not connected. (503)" }, [{ id: 1, name: "Supplies", qbAccount: "8006" }]);
    expect(screen.getByText("Couldn't load QuickBooks' account list")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "QuickBooks account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /account id/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Not in QuickBooks")).not.toBeInTheDocument();
  });
});
