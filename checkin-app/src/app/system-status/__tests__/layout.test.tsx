import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SystemStatusLayout from "../layout";
import { QBO_CODES_PATH, SYSTEM_STATUS } from "@/lib/nav/sections/systemStatus";

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

  it("admits finance on QuickBooks codes and shows no other tab", () => {
    renderLayout(QBO_CODES_PATH, {
      data: { user: { id: 6, isFinance: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(screen.getByText("QuickBooks codes")).toBeInTheDocument();
    for (const link of SYSTEM_STATUS.links.filter((l) => l.href !== QBO_CODES_PATH)) {
      expect(screen.queryByText(link.name)).not.toBeInTheDocument();
    }
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ["a board member", { isBoardMember: true }],
    ["a sysadmin", { isSysadmin: true }],
  ])("admits %s on QuickBooks codes with the sysadmin and board tabs", (_who, flags) => {
    renderLayout(QBO_CODES_PATH, {
      data: { user: { id: 7, ...flags } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    for (const name of ["QuickBooks codes", "Errors", "Audit Log", "Unsynced Scans"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(push).not.toHaveBeenCalled();
  });

  it.each(SYSTEM_STATUS.links.filter((l) => l.href !== QBO_CODES_PATH).map((l) => l.href))(
    "redirects finance off %s",
    (href) => {
      renderLayout(href, {
        data: { user: { id: 6, isFinance: true } },
        status: "authenticated",
      });
      expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
      expect(push).toHaveBeenCalledWith("/");
    },
  );

  it("does not admit operations on unsynced-scans", () => {
    renderLayout("/system-status/unsynced-scans", {
      data: { user: { id: 5, isOperations: true } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });
});
