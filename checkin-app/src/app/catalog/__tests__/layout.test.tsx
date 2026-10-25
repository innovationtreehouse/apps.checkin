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

  it("groups Locations under Org Inventory", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/locations");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Org Inventory/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Locations/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /Categories/ })).not.toBeInTheDocument();
  });

  it("hides the sub-row on a tab without sub-pages", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/received-deltas");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Categories/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Locations/ })).not.toBeInTheDocument();
  });
});

describe("org inventory subtabs", () => {
  const subtabNames = () => {
    const names = screen.getAllByRole("tab").map((t) => (t.textContent ?? "").replace(/^[^A-Za-z]+/, ""));
    return names.slice(names.findIndex((n) => n.includes("All inventory")));
  };

  it("lays out one row for an inventory manager: All inventory, Needs a location, Receive queue, Locations, Inventory log", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(subtabNames()).toEqual(["All inventory", "Needs a location", "Receive queue", "Locations", "Inventory log"]);
    expect(screen.getByRole("tab", { name: /All inventory/ })).toHaveAttribute("aria-selected", "true");
  });

  it("hides the manager-only Needs a location from Board", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(subtabNames()).toEqual(["All inventory", "Receive queue", "Locations", "Inventory log"]);
  });

  it("shows a catalog viewer without a receiving role only All inventory and Locations", () => {
    setSession({ id: 2, ageBand: "youth", isProgramVolunteer: true, isActiveOrgMember: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(subtabNames()).toEqual(["All inventory", "Locations"]);
  });

  it.each([
    ["/inventory/receive-queue", /Receive queue/],
    ["/inventory/inventory-log", /Inventory log/],
    ["/inventory/unlocated", /Needs a location/],
  ])("selects Org Inventory and its subtab on %s", (path, name) => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname(path);
    renderLayout();
    expect(screen.getByRole("tab", { name: /Org Inventory/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });

  it("has no top-level Receive queue tab and no Items subtab", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/received-deltas");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Receive queue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Items$/ })).not.toBeInTheDocument();
  });
});

describe("part mapping tab", () => {
  it("names the receipt-mapping queue Part mapping, not Receiving", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/receiving");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Part mapping/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /^Receiving/ })).not.toBeInTheDocument();
  });
});
