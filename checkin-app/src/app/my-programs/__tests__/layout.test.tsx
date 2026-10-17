import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import MyProgramsLayout from "../layout";

const push = jest.fn();
let mockPathname = "/my-programs";
let mockSession: { status: string; data?: { user: { id: number } } };
let mockCounts: TodoCounts | null;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));
jest.mock("@/hooks/useTodoCounts", () => ({
  useTodoCounts: () => mockCounts,
}));
jest.mock("@/hooks/useConflicts", () => ({
  useConflicts: () => ({ conflicts: [] }),
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
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ||
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

const CHILD = "child-marker";
const renderLayout = (pathname: string, session: typeof mockSession, counts: TodoCounts | null) => {
  mockPathname = pathname;
  mockSession = session;
  mockCounts = counts;
  return render(
    <MantineProvider>
      <MyProgramsLayout>
        <div>{CHILD}</div>
      </MyProgramsLayout>
    </MantineProvider>,
  );
};

const leadCounts = {
  lead: { programs: [{ id: 1, name: "Robotics", totalEnrolled: 4, pending: [{ id: 1, label: "x" }], upcoming: [] }] },
} as unknown as TodoCounts;

const noLeadCounts = { lead: { programs: [] } } as unknown as TodoCounts;

beforeEach(() => {
  push.mockClear();
});

describe("MyProgramsLayout lead gate", () => {
  it("admits a program lead mentor", () => {
    renderLayout("/my-programs", { status: "authenticated" }, leadCounts);
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects an authenticated caller who leads no program (once counts resolve)", () => {
    renderLayout("/my-programs", { status: "authenticated" }, noLeadCounts);
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("admits a program treasurer who leads no program, showing only Expense approvals", () => {
    const treasurerCounts = {
      lead: { programs: [] },
      releasedLibraries: ["expense"],
      libraries: { expense: { approver: 1 } },
    } as unknown as TodoCounts;
    renderLayout("/my-programs/expense-approvals", { status: "authenticated", data: { user: { id: 5 } } }, treasurerCounts);
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Expense approvals")).toBeInTheDocument();
    expect(screen.queryByText("Attendance")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/my-programs", { status: "unauthenticated" }, null);
    expect(push).toHaveBeenCalledWith("/");
  });
});
