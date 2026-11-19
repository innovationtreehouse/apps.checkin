import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SafetyLayout from "../layout";

const push = jest.fn();
let mockPathname = "/safety/emergency-contacts";
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
      <SafetyLayout>
        <div>{CHILD}</div>
      </SafetyLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
  mockCounts = null;
});

describe("SafetyLayout role gate", () => {
  it("admits a keyholder but hides the board-only Trusted Adults tab", () => {
    renderLayout("/safety/emergency-contacts", {
      data: { user: { id: 1, isKeyholder: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.queryByText(/Trusted Adults/)).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the Trusted Adults tab for a board member", () => {
    renderLayout("/safety/emergency-contacts", {
      data: { user: { id: 2, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText(/Trusted Adults/)).toBeInTheDocument();
  });

  it("redirects an authenticated user with none of the allowed roles", () => {
    renderLayout("/safety/emergency-contacts", {
      data: { user: { id: 3 } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/safety/emergency-contacts", { data: null, status: "unauthenticated" });
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("SafetyLayout Trusted Adults badge", () => {
  it("caps the pill at 99+ and keeps the exact count in its accessible name", () => {
    mockCounts = { admin: { trustedAdults: 250 } };
    renderLayout("/safety/emergency-contacts", {
      data: { user: { id: 2, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByLabelText("250 trusted-adult disclosures to review")).toHaveTextContent(/^99\+$/);
  });
});
