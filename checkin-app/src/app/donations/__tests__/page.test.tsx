type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { waitFor } from "@testing-library/react";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import { mockFetchJson, renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import DonationsIndex from "../page";

const todoCounts = (personId: number) => ({
  "/api/nav/todo-counts": {
    personId,
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries: [...LIBRARY_KEYS],
  },
});

beforeEach(() => resetRtl());

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
});
