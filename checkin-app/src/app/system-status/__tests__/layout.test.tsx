import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SystemStatusLayout from "../layout";

const push = jest.fn();
let mockPathname = "/system-status/health";
let mockSession: { data: unknown; status: string };

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
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
      <SystemStatusLayout>
        <div>{CHILD}</div>
      </SystemStatusLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
});

describe("SystemStatusLayout role gate", () => {
  it("admits a board member to every tab, Audit Log included", () => {
    renderLayout("/system-status/health", {
      data: { user: { id: 1, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Audit Log")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the Audit Log tab for a sysadmin", () => {
    renderLayout("/system-status/health", {
      data: { user: { id: 2, isSysadmin: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Audit Log")).toBeInTheDocument();
  });

  it("redirects an authenticated user with none of the allowed roles", () => {
    renderLayout("/system-status/health", {
      data: { user: { id: 3 } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/system-status/health", { data: null, status: "unauthenticated" });
    expect(push).toHaveBeenCalledWith("/");
  });

  it("admits a keyholder on unsynced-scans and hides every other tab", () => {
    renderLayout("/system-status/unsynced-scans", {
      data: { user: { id: 4, isKeyholder: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("Unsynced Scans")).toBeInTheDocument();
    expect(screen.queryByText("Errors")).not.toBeInTheDocument();
    expect(screen.queryByText("Audit Log")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects a keyholder off the other System Status tabs", () => {
    renderLayout("/system-status/health", {
      data: { user: { id: 4, isKeyholder: true } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("does not admit operations on unsynced-scans (#1633)", () => {
    renderLayout("/system-status/unsynced-scans", {
      data: { user: { id: 5, isOperations: true } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });
});
