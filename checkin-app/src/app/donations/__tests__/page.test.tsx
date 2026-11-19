type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { act, screen, waitFor } from "@testing-library/react";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import { mockFetchJson, renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import DonationsIndex from "../page";

const todoCounts = (personId: number, releasedLibraries: string[] = [...LIBRARY_KEYS]) => ({
  "/api/nav/todo-counts": {
    personId,
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries,
  },
});

beforeEach(() => resetRtl());
afterEach(() => jest.useRealTimers());

describe("DonationsIndex", () => {
  it("lands FINANCE on Benevity's first screen", async () => {
    setSession({ id: 11, isFinance: true });
    mockFetchJson(todoCounts(11));
    renderWithProviders(<DonationsIndex />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/donations/uploads"));
  });

  it("lands operations on the no-receipt gifts, the one screen they can open", async () => {
    setSession({ id: 12, isOperations: true });
    mockFetchJson(todoCounts(12));
    renderWithProviders(<DonationsIndex />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/donations/in-kind-gifts"));
  });

  it("tells a viewer whose library is not released that no screen is open yet", async () => {
    setSession({ id: 13, isFinance: true });
    mockFetchJson(todoCounts(13, []));
    renderWithProviders(<DonationsIndex />);
    expect(await screen.findByText("No Donations screen is open to you yet.")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("lands the Board on its first tab without waiting for the counts", async () => {
    setSession({ id: 14, isBoardMember: true });
    mockFetchJson({});
    renderWithProviders(<DonationsIndex />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/donations/uploads"));
  });

  it("shows a loader, then lands on the first tab by role, when the counts request fails", async () => {
    jest.useFakeTimers();
    setSession({ id: 15, isOperations: true });
    mockFetchJson({});
    renderWithProviders(<DonationsIndex />);
    expect(document.querySelector(".mantine-Loader-root")).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(3000); });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/donations/in-kind-gifts"));
  });
});
