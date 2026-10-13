import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FinanceOpsLayout from "../layout";

const push = jest.fn();
let mockPathname = "/finance-ops/payment-plan";
let mockSession: { data: unknown; status: string };

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));
// The layout reads live badge counts; stub them out so the gate test doesn't hit
// the network. tabBadgeFor(null) returns null, so no badges render.
jest.mock("@/hooks/useTodoCounts", () => ({
  useTodoCounts: () => null,
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
const renderLayout = (pathname: string, session: { data: unknown; status: string }) => {
  mockPathname = pathname;
  mockSession = session;
  return render(
    <MantineProvider>
      <FinanceOpsLayout>
        <div>{CHILD}</div>
      </FinanceOpsLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
});

describe("Revenue Ops layout role gate", () => {
  it("admits a board member, with the Board-only finance tabs", () => {
    renderLayout("/finance-ops/payment-plan", {
      data: { user: { id: 1, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Program Payment Plan")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("admits a FINANCE-only user without the Board-only finance tabs", () => {
    renderLayout("/income", {
      data: { user: { id: 4, isFinance: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.queryByText("Program Payment Plan")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects a sysadmin (finance-ops is board-only, issue #1083)", () => {
    renderLayout("/finance-ops/payment-plan", {
      data: { user: { id: 3, isSysadmin: true, isBoardMember: false } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects an authenticated user with none of the allowed roles", () => {
    renderLayout("/finance-ops/payment-plan", {
      data: { user: { id: 2 } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/finance-ops/payment-plan", { data: null, status: "unauthenticated" });
    expect(push).toHaveBeenCalledWith("/");
  });
});
