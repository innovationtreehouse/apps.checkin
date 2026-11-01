type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, resolvedParams, router, setSession } from "@/test-helpers/rtl";
import HouseholdDetailPage from "../page";

const ROUTE = "/api/membership-ops/households?id=7";
const params = resolvedParams({ id: "7" });

beforeEach(() => resetRtl());

describe("household detail page", () => {
  it("shows the household and its people", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ [ROUTE]: { household: { id: 7, name: "Rivera", householdMembers: [{ id: 9, name: "Sam Rivera", programParticipants: [] }] } } });
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(await screen.findByText("Rivera")).toBeInTheDocument();
    expect(screen.getByText("Sam Rivera")).toBeInTheDocument();
  });

  it("says when the household does not exist", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ [ROUTE]: { household: null } });
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(await screen.findByText("Household not found.")).toBeInTheDocument();
  });

  it("shows a failed load as a failure, not as a missing household", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({});
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(await screen.findByText("Couldn't load the household")).toBeInTheDocument();
    expect(screen.queryByText("Household not found.")).not.toBeInTheDocument();
  });

  it("fetches nothing for anyone else", async () => {
    setSession({ id: 2, isKeyholder: true });
    const fetchSpy = mockFetchJson({});
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(router.push).toHaveBeenCalledWith("/");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
