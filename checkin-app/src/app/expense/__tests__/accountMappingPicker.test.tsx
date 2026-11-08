jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import AccountMappingPage from "@checkin/expense/pages/accountMapping";
import { resetRtl } from "@/test-helpers/rtl";

beforeEach(() => resetRtl());

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  paged: (path: string, page: number) => `${path}?page=${page}`,
  send: jest.fn(),
}));
jest.mock("@checkin/component-ui", () => ({ ...jest.requireActual("@checkin/component-ui"), CatalogPicker: () => null }));

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

beforeEach(() => {
  mockLoads = {
    "/account-mapping?page=1": [],
    "/qb-accounts": [
      { id: 1, name: "Supplies", qbAccount: "4000" },
      { id: 2, name: "Equipment", qbAccount: "1500" },
    ],
    "/api/books-map/quickbooks-accounts": [
      { id: "4000", name: "Supplies", accountType: "Expense", active: true },
      { id: "1500", name: "Equipment", accountType: "Fixed Asset", active: true },
    ],
  };
  render(<MantineProvider><AccountMappingPage /></MantineProvider>);
});

const offered = () => {
  fireEvent.click(screen.getByRole("textbox", { name: "QuickBooks account" }));
  return screen.getAllByRole("option").map((o) => o.textContent);
};

describe("Account mapping rule picker", () => {
  it("offers a rule that doesn't say it's capital only expense accounts", () => {
    expect(offered()).toEqual(["Supplies"]);
  });

  it("offers a capital rule only Fixed Asset accounts", () => {
    fireEvent.click(screen.getByRole("textbox", { name: "Capital" }));
    fireEvent.click(screen.getByRole("option", { name: "Yes" }));
    expect(offered()).toEqual(["Equipment"]);
  });
});
