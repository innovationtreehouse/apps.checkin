jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn() }));
jest.mock("@checkin/local-inventory/pages/inventoryLog", () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

import { render } from "@testing-library/react";
import { resetRtl, setSession } from "@/test-helpers/rtl";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import InventoryLogPage from "@checkin/local-inventory/pages/inventoryLog";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import { receivedReceiptIds } from "@/lib/inventory/partMappingLinks";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import InventoryLog from "../inventory-log/page";

const counts = (releasedLibraries: string[]) => ({
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  buildingReachable: true,
  activePrograms: 0,
  releasedLibraries,
}) as TodoCounts;

const resolverPassed = () => (InventoryLogPage as jest.Mock).mock.calls.at(-1)?.[0]?.receivedReceiptIds;

beforeEach(() => {
  resetRtl();
  (InventoryLogPage as jest.Mock).mockClear();
});

describe("inventory log host page", () => {
  it.each([
    ["an inventory manager", { id: 1, isInventoryManager: true }],
    ["FINANCE", { id: 2, isFinance: true }],
    ["Board", { id: 3, isBoardMember: true }],
  ])("links receipts to Part mapping for %s once workflow-mapping is released", (_, user) => {
    setSession(user);
    (useTodoCounts as jest.Mock).mockReturnValue(counts([...LIBRARY_KEYS]));
    render(<InventoryLog />);
    expect(resolverPassed()).toBe(receivedReceiptIds);
  });

  it("leaves receipts unlinked while workflow-mapping is unreleased", () => {
    setSession({ id: 2, isFinance: true });
    (useTodoCounts as jest.Mock).mockReturnValue(counts(LIBRARY_KEYS.filter((k) => k !== "workflow-mapping")));
    render(<InventoryLog />);
    expect(resolverPassed()).toBeUndefined();
  });

  it("leaves receipts unlinked for a viewer Part mapping does not admit", () => {
    setSession({ id: 4, ageBand: "youth", isProgramVolunteer: true, isActiveOrgMember: true });
    (useTodoCounts as jest.Mock).mockReturnValue(counts([...LIBRARY_KEYS]));
    render(<InventoryLog />);
    expect(resolverPassed()).toBeUndefined();
  });
});
