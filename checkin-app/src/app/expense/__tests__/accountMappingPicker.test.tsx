jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock({ followUrl: true }));
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import AccountMappingPage, { nameOptions } from "@checkin/expense/pages/accountMapping";
import { resetRtl } from "@/test-helpers/rtl";

beforeEach(() => resetRtl());

let mockLoads: Record<string, unknown> = {};
let mockErrors: Record<string, string> = {};
const mockSend = jest.fn();

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({
    data: path ? mockLoads[path] ?? null : null,
    error: path ? mockErrors[path] ?? null : null,
    reload: () => {},
  }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  paged: (path: string, page: number) => `${path}?page=${page}`,
  send: (...args: unknown[]) => mockSend(...args),
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
  mockSend.mockClear();
  mockErrors = {};
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
    "/api/catalog/categories": [
      { id: 1, name: "Electronics", letter: "E" },
      { id: 2, name: "Wood", letter: "W" },
    ],
    "/api/catalog/subcategories": [
      { id: 10, name: "Resistors", number: 1, categoryId: 1 },
      { id: 11, name: "Capacitors", number: 2, categoryId: 1 },
      { id: 20, name: "Plywood", number: 1, categoryId: 2 },
    ],
  };
  render(<MantineProvider><AccountMappingPage /></MantineProvider>);
});

const offeredBy = (name: string) => {
  fireEvent.click(screen.getByRole("textbox", { name }));
  return screen.getAllByRole("option").map((o) => o.textContent);
};
const offered = () => offeredBy("QuickBooks account");
const pick = (name: string, option: string) => {
  fireEvent.click(screen.getByRole("textbox", { name }));
  fireEvent.click(screen.getByRole("option", { name: option }));
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

describe("Account mapping category and subcategory pickers", () => {
  it("offers Any plus the catalog categories", () => {
    expect(offeredBy("Category")).toEqual(["Any", "Electronics", "Wood"]);
  });

  it("leaves the subcategory at Any while the category is Any", () => {
    expect(screen.getByRole("textbox", { name: "Subcategory" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Subcategory" })).toHaveValue("Any");
  });

  it("offers only the chosen category's subcategories", () => {
    pick("Category", "Electronics");
    expect(offeredBy("Subcategory")).toEqual(["Any", "Resistors", "Capacitors"]);
  });

  it("resets the subcategory to Any when the category changes", () => {
    pick("Category", "Electronics");
    pick("Subcategory", "Resistors");
    pick("Category", "Wood");
    expect(screen.getByRole("textbox", { name: "Subcategory" })).toHaveValue("Any");
    pick("Subcategory", "Plywood");
    pick("Category", "Any");
    expect(screen.getByRole("textbox", { name: "Subcategory" })).toHaveValue("Any");
    expect(screen.getByRole("textbox", { name: "Subcategory" })).toBeDisabled();
  });

  it("saves Any as *", () => {
    pick("QuickBooks account", "Supplies");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(mockSend).toHaveBeenCalledWith(
      "/account-mapping",
      "POST",
      expect.objectContaining({ category: "*", subcategory: "*" }),
      "Rule added",
    );
  });

  it("saves the chosen names", () => {
    pick("Category", "Wood");
    pick("Subcategory", "Plywood");
    pick("QuickBooks account", "Supplies");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(mockSend).toHaveBeenCalledWith(
      "/account-mapping",
      "POST",
      expect.objectContaining({ category: "Wood", subcategory: "Plywood" }),
      "Rule added",
    );
  });
});

describe("nameOptions", () => {
  it("keeps a stored value the catalog no longer lists", () => {
    expect(nameOptions(["Wood"], "Metal").map((o) => o.value)).toEqual(["*", "Metal", "Wood"]);
  });

  it("does not repeat a value the catalog lists", () => {
    expect(nameOptions(["Wood", "Wood"], "Wood").map((o) => o.value)).toEqual(["*", "Wood"]);
  });
});

describe("Account mapping catalog load failure", () => {
  it("shows each failed catalog load on its select", () => {
    cleanup();
    mockErrors = { "/api/catalog/categories": "HTTP 500", "/api/catalog/subcategories": "HTTP 503" };
    render(<MantineProvider><AccountMappingPage /></MantineProvider>);
    expect(screen.getByText("Couldn't load categories: HTTP 500")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load subcategories: HTTP 503")).toBeInTheDocument();
  });
});
