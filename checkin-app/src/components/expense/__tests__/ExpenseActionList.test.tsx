import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { ExpenseActionList } from "../ExpenseActionList";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 3, isFinance: true } }, status: "authenticated" }) }));
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn() }));
jest.mock("@checkin/expense/components/api", () => ({
  PAGE_SIZE: 50,
  useLoad: (path: string) => ({ data: path === "/counts" ? { owner_approval: 4, capital_review: 2 } : null, error: null, reload: () => {} }),
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

describe("ExpenseActionList", () => {
  it("puts a green pill on each view with items the viewer can act on, and none elsewhere", () => {
    mockedUseTodoCounts.mockReturnValue(withExpenseCounts({ "actionable:owner_approval": 3, "actionable:qb_pending": 1, "actionable:capital_review": 0 }));
    render(<MantineProvider><ExpenseActionList detailBase="/expense/expenses" defaultView="all" /></MantineProvider>);

    expect(screen.getAllByLabelText(/you can act on$/).map((b) => b.getAttribute("aria-label"))).toEqual(["3 you can act on", "1 you can act on"]);
    // The view's total stays beside the pill.
    expect(screen.getByText("Owner approval (4)")).toBeInTheDocument();
    expect(screen.getByText("Capital review (2)")).toBeInTheDocument();
  });

  it("still shows the list when the counts are missing or failed, with no pills and no approver views", () => {
    mockedUseTodoCounts.mockReturnValue(null);
    render(<MantineProvider><ExpenseActionList detailBase="/programs-i-lead/expense-approvals" defaultView="awaiting_me" /></MantineProvider>);
    expect(screen.queryAllByLabelText(/you can act on$/)).toEqual([]);
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
