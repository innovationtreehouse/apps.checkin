type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import TombstoneCensus from "../page";

const ROUTE = "/api/membership-ops/participants/tombstones";

beforeEach(() => resetRtl());

describe("tombstone census page", () => {
  it("lists a tombstone with its survivor and archive", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      [ROUTE]: { Person: [{ id: 5, name: "Old Name", email: "old@example.com", mergedInto: { id: 6, name: "Survivor" }, _count: {} }], PersonMerge: [{ fromId: 5 }] },
    });
    renderWithProviders(<TombstoneCensus />);

    expect(await screen.findByText("Old Name")).toBeInTheDocument();
    expect(screen.getByText("Survivor")).toBeInTheDocument();
    expect(screen.getByText("archived")).toBeInTheDocument();
  });

  it("shows the failure, not an all-clear, when the load fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<TombstoneCensus />);

    expect(await screen.findByText("Couldn't load the census")).toBeInTheDocument();
    expect(screen.queryByText(/No tombstones/)).not.toBeInTheDocument();
  });

  it("fetches nothing for anyone else", () => {
    setSession({ id: 2, isKeyholder: true });
    const fetchSpy = mockFetchJson({});
    renderWithProviders(<TombstoneCensus />);

    expect(router.push).toHaveBeenCalledWith("/");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
