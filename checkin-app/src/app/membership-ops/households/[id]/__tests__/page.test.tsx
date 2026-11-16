type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { fireEvent, screen, waitFor } from "@testing-library/react";
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

  it("lets a board member archive the household after confirming", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchSpy = mockFetchJson({
      [ROUTE]: { household: { id: 7, name: "Rivera", householdMembers: [] } },
      "/api/membership-ops/households/7/archive": { household: { id: 7 } },
    });
    renderWithProviders(<HouseholdDetailPage params={params} />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive household…" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive household" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/membership-ops/households/7/archive", expect.objectContaining({ method: "POST" })));
  });

  it("offers unarchive on an archived household", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ [ROUTE]: { household: { id: 7, name: "Rivera", archivedAt: "2026-11-01T00:00:00.000Z", householdMembers: [] } } });
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(await screen.findByRole("button", { name: "Unarchive household…" })).toBeInTheDocument();
    expect(screen.getByText(/^Archived/)).toBeInTheDocument();
  });

  it("shows no archive control to a sysadmin who is not on the Board", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ [ROUTE]: { household: { id: 7, name: "Rivera", householdMembers: [] } } });
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(await screen.findByText("Rivera")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /archive household/i })).not.toBeInTheDocument();
  });

  it("fetches nothing for anyone else", async () => {
    setSession({ id: 2, isKeyholder: true });
    const fetchSpy = mockFetchJson({});
    renderWithProviders(<HouseholdDetailPage params={params} />);

    expect(router.push).toHaveBeenCalledWith("/");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
