import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MembershipAuditLayout from "../layout";

const push = jest.fn();
let mockPathname = "/membership-audit/emergency-contacts";
let mockSession: { data: unknown; status: string };

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));
let mockCounts: unknown = null;
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
      <MembershipAuditLayout>
        <div>{CHILD}</div>
      </MembershipAuditLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
  mockCounts = null;
});

describe("MembershipAuditLayout role gate", () => {
  it("admits a board member", () => {
    renderLayout("/membership-audit/emergency-contacts", {
      data: { user: { id: 1, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects an authenticated user with none of the allowed roles", () => {
    renderLayout("/membership-audit/emergency-contacts", {
      data: { user: { id: 2 } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/membership-audit/emergency-contacts", { data: null, status: "unauthenticated" });
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("MembershipAuditLayout tab badges", () => {
  it("shows 99+ above the badge ceiling", () => {
    mockCounts = { admin: { householdsMissingContact: 250, unclaimedHouseholds: 0, brokenHouseholds: 0 } };
    renderLayout("/membership-audit/emergency-contacts", {
      data: { user: { id: 1, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByLabelText("250 households missing an emergency contact")).toHaveTextContent("99+");
  });
});
