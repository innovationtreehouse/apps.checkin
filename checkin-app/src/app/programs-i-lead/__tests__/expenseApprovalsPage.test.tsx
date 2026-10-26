import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import Page from "../expense-approvals/page";

const loaded: string[] = [];
let mockSearch = "";
let mockUser: Record<string, unknown> = { id: 4 };

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: mockUser }, status: "authenticated" }) }));
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: () => ({ libraries: { expense: { approver: 1 } } }) }));
jest.mock("@checkin/expense/components/api", () => ({
  PAGE_SIZE: 50,
  useLoad: (path: string) => {
    loaded.push(path);
    return { data: null, error: null, reload: () => {} };
  },
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

const tabs = () => screen.getAllByRole("radio").map((r) => r.getAttribute("value"));

beforeEach(() => {
  loaded.length = 0;
  mockSearch = "";
  mockUser = { id: 4 };
});

describe("Programs I Lead › Expense approvals", () => {
  it("opens on the Waiting on you view, the expenses the approver pill counts", () => {
    render(<MantineProvider><Page /></MantineProvider>);
    expect(screen.getByRole("radio", { name: "Waiting on you" })).toBeChecked();
    expect(loaded).toContain("/expenses?view=awaiting_me&page=1&limit=50");
    expect(loaded).toContain("/expenses/count?view=awaiting_me");
  });

  it("shows a program lead who approves a bucket only the views they can act in", () => {
    render(<MantineProvider><Page /></MantineProvider>);
    expect(tabs()).toEqual(["all", "awaiting_me", "owner_approval"]);
  });

  it("opens a hidden view's link on Waiting on you instead, and never loads the hidden view", () => {
    mockSearch = "view=assign_ownership";
    render(<MantineProvider><Page /></MantineProvider>);
    expect(screen.getByRole("radio", { name: "Waiting on you" })).toBeChecked();
    expect(loaded.some((p) => p.includes("assign_ownership"))).toBe(false);
  });

  it("shows a FINANCE holder who approves a bucket the FINANCE views too", () => {
    mockUser = { id: 3, isFinance: true };
    render(<MantineProvider><Page /></MantineProvider>);
    expect(tabs()).toEqual(expect.arrayContaining(["awaiting_me", "assign_ownership", "resolve_ownership", "owner_exception"]));
  });
});
