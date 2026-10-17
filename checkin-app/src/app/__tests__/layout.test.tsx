import { render, screen } from "@testing-library/react";
import RootLayout from "../layout";
import { useOrgTime } from "@/components/TimezoneProvider";

// The layout's own DB read: stubbed so this stays a composition test, but its value
// still has to reach the formatters — that wiring is the point of the second case.
jest.mock("@/lib/appSettings", () => ({
  resolveDisplayTimezone: jest.fn().mockResolvedValue("Asia/Tokyo"),
}));

// Root layout is just html/body + provider wiring, no gating of its own — every
// provider below has its own tests (or is trivial); mock them to passthroughs so
// this test exercises RootLayout's own composition, not its children's internals.
jest.mock("@/components/AuthProvider", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/EnvProvider", () => ({
  EnvProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/DevImpersonationBar", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/StagingBar", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/DevDashboard", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/OnboardingGate", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/RenewalBanner", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/DbWakeNotice", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/AppFrame", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/UnsavedChangesProvider", () => ({
  UnsavedChangesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// 9:30 PM Aug 31 in Chicago, 11:30 AM Sep 1 in Tokyo.
const INSTANT = "2026-09-01T02:30:00.000Z";

// Formats during its own render — i.e. inside the provider the layout wraps it in.
function Stamp() {
  const { formatDateTime } = useOrgTime();
  return <div>{formatDateTime(INSTANT)}</div>;
}

describe("RootLayout", () => {
  it("renders its children inside the provider chrome", async () => {
    render(
      await RootLayout({
        children: <div>{CHILD}</div>,
      }),
    );
    expect(screen.getByText(CHILD)).toBeInTheDocument();
  });

  it("formats a child's instants in the org's configured timezone", async () => {
    render(
      await RootLayout({
        children: <Stamp />,
      }),
    );
    expect(screen.getByText(/9\/1\/2026/)).toBeInTheDocument();
  });
});
