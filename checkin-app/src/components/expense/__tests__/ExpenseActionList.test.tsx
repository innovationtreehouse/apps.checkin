import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { PROGRAMS_I_LEAD } from "@/lib/nav/sections/programsILead";
import { ExpenseActionList } from "../ExpenseActionList";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/expense",
  useSearchParams: () => new URLSearchParams(),
}));
let mockUser: Record<string, unknown> = { id: 3, isFinance: true };
let mockTotals: Record<string, number> = { owner_approval: 4, capital_review: 2 };
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: mockUser }, status: "authenticated" }) }));
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn() }));
jest.mock("@checkin/expense/components/api", () => ({
  PAGE_SIZE: 50,
  useLoad: (path: string) => ({ data: path === "/counts" ? mockTotals : null, error: null, reload: () => {} }),
}));

const mockedUseTodoCounts = jest.mocked(useTodoCounts);

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
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ||
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

const withExpenseCounts = (expense: Record<string, number>) => ({ libraries: { expense } }) as unknown as TodoCounts;
const pills = () => screen.queryAllByLabelText(/ (to act on|in this queue)$/).map((b) => b.getAttribute("aria-label"));
const approvalsTab = PROGRAMS_I_LEAD.links.find((l) => l.href === "/programs-i-lead/expense-approvals");

beforeEach(() => {
  mockUser = { id: 3, isFinance: true };
  mockTotals = { owner_approval: 4, capital_review: 2 };
});

describe("ExpenseActionList", () => {
  it("puts a green pill on views the viewer can act in, a gray total where they can act on nothing, and none on empty views", () => {
    mockedUseTodoCounts.mockReturnValue(withExpenseCounts({ "actionable:owner_approval": 3, "actionable:qb_pending": 1, "actionable:capital_review": 0 }));
    mockTotals = { owner_approval: 4, capital_review: 2, qb_pending: 1, assign_ownership: 0 };
    render(<MantineProvider><ExpenseActionList detailBase="/expense/expenses" defaultView="all" /></MantineProvider>);
    expect(pills()).toEqual(["3 to act on", "2 in this queue", "1 to act on"]);
  });

  it("shows a submitter a gray pill on Owner approval for their own expense, and no tab pill", () => {
    mockUser = { id: 7 };
    mockTotals = { owner_approval: 1 };
    const counts = withExpenseCounts({ approver: 1, "actionable:owner_approval": 0 });
    mockedUseTodoCounts.mockReturnValue(counts);
    render(<MantineProvider><ExpenseActionList detailBase="/programs-i-lead/expense-approvals" defaultView="owner_approval" /></MantineProvider>);
    expect(pills()).toEqual(["1 in this queue"]);
    expect(approvalsTab?.badge?.(counts)).toBeNull();
  });

  it("shows an approver who is not conflicted green pills, and a tab pill equal to their sum", () => {
    mockUser = { id: 8, isBoardMember: true };
    mockTotals = { owner_approval: 3, qb_pending: 2 };
    const counts = withExpenseCounts({ approver: 1, "actionable:owner_approval": 2, "actionable:qb_pending": 1 });
    mockedUseTodoCounts.mockReturnValue(counts);
    render(<MantineProvider><ExpenseActionList detailBase="/programs-i-lead/expense-approvals" defaultView="awaiting_me" /></MantineProvider>);
    expect(pills()).toEqual(["2 to act on", "1 to act on"]);
    expect(approvalsTab?.badge?.(counts)?.count).toBe(3);
  });

  it("still shows the list when the counts are missing or failed, with no green pills and no approver views", () => {
    mockedUseTodoCounts.mockReturnValue(null);
    render(<MantineProvider><ExpenseActionList detailBase="/programs-i-lead/expense-approvals" defaultView="awaiting_me" /></MantineProvider>);
    expect(screen.queryAllByLabelText(/to act on$/)).toEqual([]);
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /Waiting on you/ })).toBeNull();
  });

  it("shows FINANCE who approves no bucket every view but Waiting on you", () => {
    mockedUseTodoCounts.mockReturnValue(withExpenseCounts({ approver: 0 }));
    render(<MantineProvider><ExpenseActionList detailBase="/expense/expenses" defaultView="all" /></MantineProvider>);
    expect(screen.queryByRole("radio", { name: /Waiting on you/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Assign ownership/ })).toBeInTheDocument();
  });
});
