import { fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ItemsPage from "@checkin/income/pages/items";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/income/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useIsFinance: () => true,
  api: jest.fn(),
  notifyNavCounts: jest.fn(),
  refusalMessage: (e: unknown) => String(e),
}));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn() } }));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ||= () => {};
});

beforeEach(() => {
  mockLoads = {
    "/items": [{
      variantId: "41", title: "Kit", sku: null, decision: "bucket", budgetOwnerId: 1, budgetOwnerName: "Robotics", bucketIssue: null, quickBooksAccountId: "8003",
    }],
    "/api/budget-owners": [{ id: 1, name: "Robotics" }],
    "/api/books-map/quickbooks-accounts": [
      { id: "8002", name: "Sales:Shop sales", accountType: "Income", active: true },
      { id: "8003", name: "Sales:Old kits", accountType: "Income", active: false },
    ],
  };
});

describe("Income items: inactive QuickBooks accounts", () => {
  it("offers no inactive account, and warns beside the item holding one", () => {
    render(<MantineProvider><ItemsPage /></MantineProvider>);
    const warning = screen.getByText("Sales:Old kits is inactive in QuickBooks. Pick an active one.").closest<HTMLElement>("[role=alert]")!;
    expect(within(warning).getByRole("button", { name: "Update now" })).toBeInTheDocument();
    const picker = screen.getByRole("textbox", { name: "QuickBooks account for Kit" });
    expect(picker).toHaveValue("");
    fireEvent.click(picker);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Sales:Shop sales"]);
  });
});
