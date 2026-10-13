jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn(() => null) }));

import { screen } from "@testing-library/react";
import { renderWithProviders, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";
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
  it("turns away a user whose only claim is a volunteer designation", () => {
    setSession({ id: 1, hasVolunteerDesignation: true });
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
