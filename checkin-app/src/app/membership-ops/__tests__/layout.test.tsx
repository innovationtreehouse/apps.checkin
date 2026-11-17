import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MembershipOpsLayout from "../layout";

const push = jest.fn();
let mockPathname = "/membership-ops/participants";
let mockSession: { data: unknown; status: string };
let mockCounts: unknown = null;

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
      <MembershipOpsLayout>
        <div>{CHILD}</div>
      </MembershipOpsLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
  mockCounts = null;
});

describe("MembershipOpsLayout role gate", () => {
  it("admits a sysadmin, showing admin tabs (not the reviewer-only Review tab restriction)", () => {
    renderLayout("/membership-ops/participants", {
      data: { user: { id: 1, isSysadmin: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Applications")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("admits a background-check-reviewer-only user, scoped to the Review tab", () => {
    renderLayout("/membership-ops/review", {
      data: { user: { id: 2, isBackgroundCheckReviewer: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Background-check Review")).toBeInTheDocument();
    expect(screen.queryByText("Applications")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects an authenticated user with none of the allowed roles", () => {
    renderLayout("/membership-ops/participants", {
      data: { user: { id: 3 } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/membership-ops/participants", { data: null, status: "unauthenticated" });
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("MembershipOpsLayout Applications tab pills", () => {
  it("shows the red incomplete count beside the gray rest", () => {
    mockCounts = { admin: { applicationsTotal: 5, applicationsIncomplete: 2, brokenEmails: 0 } };
    renderLayout("/membership-ops/applications", {
      data: { user: { id: 1, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByLabelText("2 applications missing a signature or background check")).toHaveTextContent("2");
    expect(screen.getByLabelText("3 other applications")).toHaveTextContent("3");
  });

  it("shows a red refund-owed pill beside the other two", () => {
    mockCounts = { admin: { applicationsTotal: 5, applicationsIncomplete: 2, applicationsAwaitingRefund: 1, brokenEmails: 0 } };
    renderLayout("/membership-ops/applications", {
      data: { user: { id: 1, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByLabelText("1 paid application of denied households awaiting a refund")).toHaveTextContent("1");
    expect(screen.getByLabelText("2 applications missing a signature or background check")).toHaveTextContent("2");
    expect(screen.getByLabelText("3 other applications")).toHaveTextContent("3");
  });
});
