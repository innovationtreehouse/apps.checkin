jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn(() => null) }));

import { screen } from "@testing-library/react";
import { renderWithProviders, setSession, setPathname, resetRtl, router } from "@/test-helpers/rtl";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import CatalogLayout from "../layout";

const counts: TodoCounts = {
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  buildingReachable: true,
  activePrograms: 0,
  releasedLibraries: [...LIBRARY_KEYS],
};

beforeEach(() => {
  resetRtl();
  (useTodoCounts as jest.Mock).mockReturnValue(counts);
});

const renderLayout = () => renderWithProviders(<CatalogLayout><div>PAGE</div></CatalogLayout>);

describe("catalog layout gate", () => {
  it("turns away an adult with no role or volunteer input", () => {
    setSession({ id: 1, ageBand: "adult" });
    renderLayout();
    expect(screen.queryByText("PAGE")).not.toBeInTheDocument();
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("admits an active youth program volunteer", () => {
    setSession({ id: 2, ageBand: "youth", isProgramVolunteer: true, isActiveOrgMember: true });
    renderLayout();
    expect(screen.getByText("PAGE")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("catalog layout tabs", () => {
  it("groups the catalog screens under Global Catalog", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/catalog/categories");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Global Catalog/ })).toHaveAttribute("aria-selected", "true");
    for (const name of ["Items", "Categories", "Proposals", "Conversion Challenges"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: /Categories/ })).toHaveAttribute("aria-selected", "true");
  });

  it("hides the sub-row on a tab without sub-pages", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/locations");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Categories/ })).not.toBeInTheDocument();
  });
});
