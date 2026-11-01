type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen, waitFor } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, setPathname, setSession } from "@/test-helpers/rtl";
import DonationsLayout from "../layout";

const ROUTE = "/api/donations/nav-counts";

beforeEach(() => {
  resetRtl();
  setPathname("/donations");
});

describe("donations layout", () => {
  it("shows a count badge from the nav counts", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ [ROUTE]: { unassignedQueue: 3, disbursementHolds: 0 } });
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("Child")).toBeInTheDocument();
  });

  it("still shows the page, with no failure, when the counts fail", async () => {
    setSession({ id: 1, isFinance: true });
    const fetchMock = mockFetchJson({});
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(ROUTE, expect.anything()));
    expect(screen.getByText("Child")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });

  it("does not read the counts for a role the screens do not admit", () => {
    setSession({ id: 2, isKeyholder: true });
    const fetchMock = mockFetchJson({});
    renderWithProviders(<DonationsLayout><p>Child</p></DonationsLayout>);

    expect(fetchMock).not.toHaveBeenCalledWith(ROUTE, expect.anything());
  });
});
