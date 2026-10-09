jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn(() => null) }));

import { screen } from "@testing-library/react";
import { renderWithProviders, setSession, setPathname, resetRtl } from "@/test-helpers/rtl";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";
import { libraryCount } from "@/components/navBadges";
import {
  EXPENSE_OPS_TABS,
  INVENTORY_LIBRARY_TABS,
  MY_PROGRAMS_LIBRARY_TABS,
  MY_RECEIPTS_TABS,
  REVENUE_OPS_LIBRARY_TABS,
  type LibraryTab,
} from "@/lib/libraryNav";
import AppFrame from "../AppFrame";

const mockedUseTodoCounts = useTodoCounts as jest.Mock;

const financeOrBoard = (u: { isFinance?: boolean; isBoardMember?: boolean } | undefined) =>
  !!u?.isFinance || !!u?.isBoardMember;

// Fake registrations standing in for the library wiring PRs.
const REGISTRATIONS: Array<[LibraryTab[], LibraryTab]> = [
  [REVENUE_OPS_LIBRARY_TABS, { name: "Income", href: "/income", library: "income", visible: financeOrBoard }],
  [
    EXPENSE_OPS_TABS,
    {
      name: "Expenses",
      href: "/expense",
      library: "expense",
      visible: financeOrBoard,
      badge: (c) => {
        const n = libraryCount(c, "expense", "holds");
        return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} expense holds` } : null;
      },
    },
  ],
  [MY_RECEIPTS_TABS, { name: "My receipts", href: "/receipts/mine", library: "receipt", visible: (u) => !!u?.isKeyholder }],
  [
    MY_PROGRAMS_LIBRARY_TABS,
    { name: "Expense approvals", href: "/my-programs/expense-approvals", library: "expense", visible: (u) => (u?.programsLed?.length ?? 0) > 0 },
  ],
  [
    INVENTORY_LIBRARY_TABS,
    { name: "Receiving", href: "/inventory/receiving", library: "workflow-mapping", visible: (u) => !!u?.isInventoryManager || financeOrBoard(u) },
  ],
];

beforeAll(() => REGISTRATIONS.forEach(([slot, tab]) => slot.push(tab)));
afterAll(() => REGISTRATIONS.forEach(([slot]) => slot.splice(0)));
beforeEach(() => {
  resetRtl();
  mockedUseTodoCounts.mockReturnValue(counts());
});

const counts = (extra: Partial<TodoCounts> = {}): TodoCounts => ({
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  activePrograms: 0,
  releasedLibraries: [...LIBRARY_KEYS],
  ...extra,
});

const renderFrame = () => renderWithProviders(<AppFrame>{<div>PAGE</div>}</AppFrame>);
const hrefOf = (label: string) => screen.getByText(label).closest("a")?.getAttribute("href");

describe("AppFrame library nav slots", () => {
  it("Board: Revenue Ops (legacy first), Expense Ops, Inventory", () => {
    setSession({ id: 1, isBoardMember: true });
    renderFrame();
    expect(hrefOf("Revenue Ops")).toBe("/finance-ops/payment-plan");
    expect(hrefOf("Expense Ops")).toBe("/expense");
    expect(hrefOf("Inventory")).toBe("/catalog/items");
    expect(screen.queryByText("My Receipts")).not.toBeInTheDocument();
    expect(screen.queryByText("My Programs")).not.toBeInTheDocument();
  });

  it("FINANCE-only: Revenue Ops lands on Income (no legacy tab); Inventory lands on Receiving", () => {
    setSession({ id: 2, isFinance: true });
    renderFrame();
    expect(hrefOf("Revenue Ops")).toBe("/income");
    expect(hrefOf("Expense Ops")).toBe("/expense");
    expect(hrefOf("Inventory")).toBe("/inventory/receiving");
  });

  it("program lead: My Programs and Inventory, no Ops sections", () => {
    setSession({ id: 3, programsLed: [9] });
    mockedUseTodoCounts.mockReturnValue(counts({ lead: { programs: [{ id: 9, name: "P", totalEnrolled: 0, pending: [], upcoming: [] }] } }));
    renderFrame();
    expect(hrefOf("My Programs")).toBe("/my-programs");
    expect(hrefOf("Inventory")).toBe("/catalog/items");
    expect(screen.queryByText("Revenue Ops")).not.toBeInTheDocument();
    expect(screen.queryByText("Expense Ops")).not.toBeInTheDocument();
  });

  it("catalog viewer (keyholder): Inventory and My Receipts right after My Activities", () => {
    setSession({ id: 4, isKeyholder: true });
    renderFrame();
    expect(hrefOf("Inventory")).toBe("/catalog/items");
    expect(hrefOf("My Receipts")).toBe("/receipts/mine");
    const labels = screen.getAllByRole("link").map((a) => a.textContent);
    expect(labels.indexOf("My Receipts")).toBe(labels.indexOf("My Activities") + 1);
    expect(screen.queryByText("Revenue Ops")).not.toBeInTheDocument();
  });

  it("hides an unreleased library's tab from non-Board and keeps it for Board", () => {
    mockedUseTodoCounts.mockReturnValue(counts({ releasedLibraries: ["catalog", "local-inventory"] }));
    setSession({ id: 2, isFinance: true });
    const { unmount } = renderFrame();
    expect(screen.queryByText("Revenue Ops")).not.toBeInTheDocument();
    expect(screen.queryByText("Expense Ops")).not.toBeInTheDocument();
    unmount();
    setSession({ id: 1, isBoardMember: true });
    renderFrame();
    expect(hrefOf("Expense Ops")).toBe("/expense");
  });

  it("plain member: none of the library entries", () => {
    setSession({ id: 5 });
    renderFrame();
    for (const label of ["Inventory", "Revenue Ops", "Expense Ops", "My Receipts", "My Programs"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("folds a library tab's pill into its section entry and highlights the entry on its routes", () => {
    setSession({ id: 2, isFinance: true });
    setPathname("/expense/42");
    mockedUseTodoCounts.mockReturnValue(counts({ libraries: { expense: { holds: 3 } } }));
    renderFrame();
    expect(screen.getByLabelText("3 expense holds")).toHaveTextContent("3");
    expect(screen.getByText("Expense Ops").closest("a")).toHaveAttribute("data-active", "true");
    expect(screen.getByText("Revenue Ops").closest("a")).not.toHaveAttribute("data-active");
  });
});
