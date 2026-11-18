import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import ProgramsILeadLayout from "../layout";

const push = jest.fn();
let mockPathname = "/programs-i-lead";
let mockSession: { status: string; data?: { user: { id: number } } };
let mockCounts: TodoCounts | null;
let mockConflicts: unknown[] = [];

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
  useConflicts: () => ({ conflicts: mockConflicts }),
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
      <ProgramsILeadLayout>
        <div>{CHILD}</div>
      </ProgramsILeadLayout>
    </MantineProvider>,
  );
};

const leadCounts = {
  lead: { programs: [{ id: 1, name: "Robotics", totalEnrolled: 4, pending: [{ id: 1, label: "x" }], upcoming: [] }] },
} as unknown as TodoCounts;

const noLeadCounts = { lead: { programs: [] } } as unknown as TodoCounts;

beforeEach(() => {
  push.mockClear();
  mockConflicts = [];
});

describe("ProgramsILeadLayout lead gate", () => {
  it("admits a program lead mentor", () => {
    renderLayout("/programs-i-lead", { status: "authenticated" }, leadCounts);
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects an authenticated caller who leads no program (once counts resolve)", () => {
    renderLayout("/programs-i-lead", { status: "authenticated" }, noLeadCounts);
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("admits a program treasurer who leads no program, showing only Expense approvals", () => {
    const treasurerCounts = {
      lead: { programs: [] },
      releasedLibraries: ["expense"],
      libraries: { expense: { approver: 1 } },
    } as unknown as TodoCounts;
    renderLayout("/programs-i-lead/expense-approvals", { status: "authenticated", data: { user: { id: 5 } } }, treasurerCounts);
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Expense approvals")).toBeInTheDocument();
    expect(screen.queryByText("Attendance")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/programs-i-lead", { status: "unauthenticated" }, null);
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("ProgramsILeadLayout tab badges", () => {
  it("caps both pills at 99+ and keeps the exact counts in their accessible names", () => {
    const pending = Array.from({ length: 250 }, (_, i) => ({ id: i, label: "x" }));
    const counts = {
      lead: { programs: [{ id: 1, name: "Robotics", totalEnrolled: 4, pending, upcoming: [] }] },
    } as unknown as TodoCounts;
    mockConflicts = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    renderLayout("/programs-i-lead", { status: "authenticated" }, counts);
    expect(screen.getByLabelText("250 attendance items to confirm")).toHaveTextContent(/^99\+$/);
    expect(screen.getByLabelText("250 conflicts to resolve")).toHaveTextContent(/^99\+$/);
  });
});
