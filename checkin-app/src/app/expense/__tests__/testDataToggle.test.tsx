import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";
import Page from "../expenses/[id]/page";

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({
    data: path === "/expenses/e1"
      ? {
          id: "e1", vendorName: "TEST-Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "owner_approval",
          needsReimbursement: false, backfill: false, isTestData: false, lineItems: [], approvals: [],
        }
      : null,
    error: null,
    reload: () => {},
  }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
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
});

describe("Test data toggle on the expense detail page", () => {
  const prev = process.env.CHECKIN_ENV;
  afterAll(() => {
    if (prev === undefined) delete process.env.CHECKIN_ENV;
    else process.env.CHECKIN_ENV = prev;
  });

  it("shows for FINANCE when the host allows it", () => {
    render(<MantineProvider><ExpenseDetailPage id="e1" testDataToggle /></MantineProvider>);
    expect(screen.getByRole("switch", { name: "Test data" })).not.toBeChecked();
  });

  it("is hidden by default", () => {
    render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);
    expect(screen.queryByRole("switch", { name: "Test data" })).not.toBeInTheDocument();
  });

  it.each([["prod", false], ["stg", false], [undefined, false], ["dev", true], ["local", true]])("on %p the host page passes testDataToggle=%s", async (env, shown) => {
    if (env === undefined) delete process.env.CHECKIN_ENV;
    else process.env.CHECKIN_ENV = env;
    const el = await Page({ params: Promise.resolve({ id: "e1" }), searchParams: Promise.resolve({}) });
    expect(el.props.testDataToggle).toBe(shown);
  });

  it.each([
    [{}, "/expense/expenses"],
    [{ from: "/expense/holds" }, "/expense/holds"],
    [{ from: "/expense/expenses?view=qb_pending&page=2" }, "/expense/expenses?view=qb_pending&page=2"],
    [{ from: "//evil.example" }, "/expense/expenses"],
  ])("with %p the back link returns to %s", async (searchParams, listHref) => {
    const el = await Page({ params: Promise.resolve({ id: "e1" }), searchParams: Promise.resolve(searchParams) });
    expect(el.props.listHref).toBe(listHref);
  });
});
