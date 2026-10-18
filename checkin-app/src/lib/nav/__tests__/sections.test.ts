import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavSection, NavUser } from "@/lib/nav/types";
import { hasAnyRole, linkGate, sectionShown, visibleLinks } from "@/lib/nav/gates";
import { SAFETY } from "@/lib/nav/sections/safety";
import { MY_ACTIVITIES } from "@/lib/nav/sections/myActivities";
import { MY_RECEIPTS } from "@/lib/nav/sections/myReceipts";
import { RECEIPT_REVIEW } from "@/lib/nav/sections/receiptReview";
import { PROGRAMS_I_LEAD } from "@/lib/nav/sections/programsILead";
import { SHOP_OPS } from "@/lib/nav/sections/shopOps";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { FACILITY_OPS } from "@/lib/nav/sections/facilityOps";
import { MEMBERSHIP_OPS } from "@/lib/nav/sections/membershipOps";
import { MEMBERSHIP_AUDIT } from "@/lib/nav/sections/membershipAudit";
import { PROGRAM_OPS } from "@/lib/nav/sections/programOps";
import { REVENUE_OPS } from "@/lib/nav/sections/revenueOps";
import { EXPENSE_OPS } from "@/lib/nav/sections/expenseOps";
import { SYSTEM_STATUS } from "@/lib/nav/sections/systemStatus";
import { SETTINGS } from "@/lib/nav/sections/settings";
import { DEV_TOOLS } from "@/lib/nav/sections/devTools";

const SECTIONS: NavSection[] = [
  SAFETY, MY_ACTIVITIES, MY_RECEIPTS, RECEIPT_REVIEW, PROGRAMS_I_LEAD, SHOP_OPS, INVENTORY, FACILITY_OPS,
  MEMBERSHIP_OPS, MEMBERSHIP_AUDIT, PROGRAM_OPS, REVENUE_OPS, EXPENSE_OPS, SYSTEM_STATUS, SETTINGS, DEV_TOOLS,
];

const adult = { ageBand: "adult" as const, isActiveOrgMember: true };
const PERSONAS: Record<string, NavUser> = {
  member: adult,
  programLeader: { ...adult, programsLed: [9] },
  keyholder: { isKeyholder: true },
  operations: { isOperations: true },
  finance: { isFinance: true },
  inventoryManager: { isInventoryManager: true },
  certifier: { ...adult, toolStatuses: [{ level: "MAY_CERTIFY_OTHERS" }] },
  bgReviewer: { isBackgroundCheckReviewer: true },
  board: { isBoardMember: true },
  sysadmin: { isSysadmin: true },
};

const counts: TodoCounts = {
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  buildingReachable: true,
  activePrograms: 0,
  releasedLibraries: [...LIBRARY_KEYS],
  lead: { programs: [{ id: 9, name: "P", totalEnrolled: 0, pending: [], upcoming: [] }] },
};

describe.each(SECTIONS.map((s) => [s.id, s] as const))("section %s", (_id, section) => {
  it("has links with unique hrefs", () => {
    const hrefs = section.links.map((l) => l.href);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  // A tab the section's gate would not admit would sit in a strip its viewer never reaches.
  // Unsynced Scans is the one deliberate exception: keyholders reach it by its own path gate.
  it("never shows a tab to someone the section does not admit", () => {
    for (const user of Object.values(PERSONAS)) {
      const tabs = visibleLinks(section, user, counts).filter((l) => l.href !== "/system-status/unsynced-scans");
      if (tabs.length > 0) expect(section.visible(user, counts)).toBe(true);
    }
  });
});

describe("hasAnyRole", () => {
  it("counts a flag only when it is exactly true", () => {
    expect(hasAnyRole({ isFinance: true }, ["isFinance", "isBoardMember"])).toBe(true);
    expect(hasAnyRole({ isFinance: false }, ["isFinance"])).toBe(false);
    expect(hasAnyRole(undefined, ["isFinance"])).toBe(false);
  });
});

describe("linkGate", () => {
  it("throws on an href that is not one of the section's links", () => {
    expect(() => linkGate(SAFETY, "/safety/nowhere")).toThrow();
  });
});

describe("the Receipts split", () => {
  it("My Receipts holds only a person's own receipts", () => {
    expect(MY_RECEIPTS.links.map((l) => l.href)).toEqual(["/receipts", "/receipts/upload"]);
  });

  it("Receipt Review holds review, settings and mail, for FINANCE or BOARD; mail for FINANCE alone", () => {
    expect(visibleLinks(RECEIPT_REVIEW, PERSONAS.finance, counts).map((l) => l.href)).toEqual([
      "/receipts/review",
      "/receipts/settings",
      "/receipts/mail",
    ]);
    expect(visibleLinks(RECEIPT_REVIEW, PERSONAS.board, counts).map((l) => l.href)).toEqual([
      "/receipts/review",
      "/receipts/settings",
    ]);
    for (const name of ["member", "sysadmin", "operations"]) {
      expect(sectionShown(RECEIPT_REVIEW, PERSONAS[name], counts)).toBe(false);
    }
  });
});

describe("Membership Ops", () => {
  it('calls the review page "Background-check Review"', () => {
    expect(MEMBERSHIP_OPS.links.find((l) => l.href === "/membership-ops/review")?.name).toBe("Background-check Review");
  });
});
