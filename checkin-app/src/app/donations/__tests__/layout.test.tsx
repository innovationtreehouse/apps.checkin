type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen, waitFor, within } from "@testing-library/react";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import { mockFetchJson, renderWithProviders, resetRtl, setPathname, setSession } from "@/test-helpers/rtl";
import DonationsLayout from "../layout";

const todoCounts = (personId: number, libraries = {}) => ({
  "/api/nav/todo-counts": {
    personId,
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries: [...LIBRARY_KEYS],
    libraries,
  },
});

const tabNames = (list: HTMLElement) => within(list).getAllByRole("tab").map((t) => t.textContent);

/** The section row and the pill row, once the release list has loaded and both are filled. */
async function tabRows() {
  await waitFor(() => expect(screen.getAllByRole("tablist")).toHaveLength(2));
  return screen.getAllByRole("tablist");
}

beforeEach(() => resetRtl());

describe("donations layout", () => {
  it("shows Benevity and In-Kind, and Benevity's screens as pills on a Benevity page", async () => {
    setSession({ id: 1, isFinance: true });
    setPathname("/donations/unassigned");
    mockFetchJson(todoCounts(1));
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    const [top, sub] = await tabRows();
    expect(tabNames(top)).toEqual(["🏢Benevity", "📦In-Kind"]);
    expect(tabNames(sub)).toEqual([
      "📤Uploads", "🎁Gifts", "📥Unassigned", "⛔Holds", "📒Booking Batches", "💬Comment Rules", "🗺️Account Map",
    ]);
    expect(screen.getByText("Child")).toBeInTheDocument();
  });

  it("shows In-Kind's screens as pills on an in-kind gift's page", async () => {
    setSession({ id: 2, isBoardMember: true });
    setPathname("/donations/in-kind/receipt/7");
    mockFetchJson(todoCounts(2));
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    const [, sub] = await tabRows();
    expect(tabNames(sub)).toEqual(["🎁Without a receipt", "📦Queue"]);
  });

  it("puts each count on its pill and their sum on the Benevity tab", async () => {
    setSession({ id: 3, isFinance: true });
    setPathname("/donations/holds");
    mockFetchJson(todoCounts(3, { "bulk-donation": { unassignedQueue: 2, disbursementHolds: 1 } }));
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows operations only In-Kind's no-receipt gifts", async () => {
    setSession({ id: 4, isOperations: true });
    setPathname("/donations/in-kind-gifts");
    mockFetchJson(todoCounts(4));
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    const [top, sub] = await tabRows();
    expect(tabNames(top)).toEqual(["📦In-Kind"]);
    expect(tabNames(sub)).toEqual(["🎁Without a receipt"]);
  });
});
