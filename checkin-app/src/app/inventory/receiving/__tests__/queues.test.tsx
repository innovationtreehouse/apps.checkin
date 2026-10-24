import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceivingPage from "@checkin/workflow-mapping/pages/receiving";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";

let mockSearch = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ replace: jest.fn() }),
}));

const COUNTS = { pending_review: 2, apply_failed: 1, applying: 5 };
const row = (id: number, state: string, vendorName: string) => ({
  id, state, vendorName, receiptTotalCents: 1000, currency: "USD", lineItemCount: 1, validationNotes: null, createdAt: "2026-10-01T00:00:00Z",
});
const mockLoads: Record<string, unknown> = {
  "/receipts/counts": COUNTS,
  "/receipts?state=apply_failed": [row(1, "apply_failed", "Failed Hardware")],
  "/receipts?state=applying": [row(2, "applying", "Pushing Lumber")],
};

jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1, isInventoryManager: true } } }) }));

jest.mock("@checkin/workflow-mapping/components/api", () => ({
  ...jest.requireActual("@checkin/workflow-mapping/components/api"),
  useLoad: (path: string) => ({ data: mockLoads[path] ?? [], error: null, reload: jest.fn() }),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const wrap = () => render(<MantineProvider><ReceivingPage /></MantineProvider>);

const navBadge = () => {
  const tab = INVENTORY.links.find((l) => l.href === "/inventory/receiving");
  const c: TodoCounts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries: [...LIBRARY_KEYS],
    libraries: { "workflow-mapping": COUNTS },
  };
  return tab?.badge?.(c);
};

describe("Receiving queues", () => {
  beforeEach(() => {
    mockSearch = new URLSearchParams();
  });

  it("counts only apply_failed under Apply failed, so the tabs that ask for a person add up to the nav pill", () => {
    wrap();
    expect(screen.getByText("Needs mapping (2)")).toBeInTheDocument();
    expect(screen.getByText("Apply failed (1)")).toBeInTheDocument();
    expect(navBadge()?.count).toBe(COUNTS.pending_review + COUNTS.apply_failed);
  });

  it("counts applying receipts under In progress", () => {
    wrap();
    expect(screen.getByText("In progress (5)")).toBeInTheDocument();
  });

  it("lists an applying receipt under In progress only, with no actions", () => {
    mockSearch = new URLSearchParams("queue=inProgress");
    wrap();
    expect(screen.getByText("Pushing Lumber")).toBeInTheDocument();
    expect(screen.queryByText("Failed Hardware")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("leaves applying receipts out of Apply failed", () => {
    mockSearch = new URLSearchParams("queue=failed");
    wrap();
    expect(screen.getByText("Failed Hardware")).toBeInTheDocument();
    expect(screen.queryByText("Pushing Lumber")).not.toBeInTheDocument();
  });
});
