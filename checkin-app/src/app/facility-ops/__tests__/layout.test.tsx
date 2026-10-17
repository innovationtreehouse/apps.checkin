import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FacilityLayout from "../layout";
import { FACILITY_NAV_LINKS } from "@/lib/facilityNav";

const push = jest.fn();
let mockPathname = "/facility-ops/visits";
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
      <FacilityLayout>
        <div>{CHILD}</div>
      </FacilityLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
});

describe("FacilityLayout role gate", () => {
  it("admits a sysadmin", () => {
    renderLayout("/facility-ops/visits", {
      data: { user: { id: 1, isSysadmin: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("admits an operations user", () => {
    renderLayout("/facility-ops/print-badges", {
      data: { user: { id: 5, isOperations: true } },
      status: "authenticated",
    });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  // SectionTabs is not role-aware, so an unfiltered strip would offer operations
  // three tabs whose pages eject them to "/" — the section is reachable for them
  // now, so the tabs have to track the same gates the pages do.
  it("shows an operations user only the tabs they can open", () => {
    renderLayout("/facility-ops/print-badges", {
      data: { user: { id: 5, isOperations: true } },
      status: "authenticated",
    });
    expect(screen.getByRole("tab", { name: /Print ID Badges/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Participation Trends/ })).toBeInTheDocument();
    for (const hidden of ["Visit History", "Raw Badge Events", "Corrections"]) {
      expect(screen.queryByRole("tab", { name: new RegExp(hidden) })).not.toBeInTheDocument();
    }
  });

  it("shows a board member every tab", () => {
    renderLayout("/facility-ops/visits", {
      data: { user: { id: 3, isBoardMember: true } },
      status: "authenticated",
    });
    expect(screen.getAllByRole("tab")).toHaveLength(FACILITY_NAV_LINKS.length);
  });

  it("redirects an authenticated user with none of the allowed roles", () => {
    renderLayout("/facility-ops/visits", {
      data: { user: { id: 2 } },
      status: "authenticated",
    });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout("/facility-ops/visits", { data: null, status: "unauthenticated" });
    expect(push).toHaveBeenCalledWith("/");
  });
});
