import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavSection, NavUser } from "@/lib/nav/types";
import { hasAnyRole, linkGate, sectionShown, visibleLinks } from "@/lib/nav/gates";
import { SAFETY } from "@/lib/nav/sections/safety";
import { MY_ACTIVITIES } from "@/lib/nav/sections/myActivities";
import { MY_RECEIPTS } from "@/lib/nav/sections/myReceipts";
import { PROGRAMS_I_LEAD } from "@/lib/nav/sections/programsILead";
import { SHOP_OPS } from "@/lib/nav/sections/shopOps";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { FACILITY_OPS } from "@/lib/nav/sections/facilityOps";
import { MEMBERSHIP_OPS } from "@/lib/nav/sections/membershipOps";
import { MEMBERSHIP_AUDIT } from "@/lib/nav/sections/membershipAudit";
import { PROGRAM_OPS } from "@/lib/nav/sections/programOps";
import { REVENUE_OPS } from "@/lib/nav/sections/revenueOps";
import { FINANCE } from "@/lib/nav/sections/finance";
import { SYSTEM_STATUS } from "@/lib/nav/sections/systemStatus";
import { SETTINGS } from "@/lib/nav/sections/settings";
import { DEV_TOOLS } from "@/lib/nav/sections/devTools";
import { tabBadgeFor } from "@/components/navBadges";

const SECTIONS: NavSection[] = [
  SAFETY, MY_ACTIVITIES, MY_RECEIPTS, PROGRAMS_I_LEAD, SHOP_OPS, INVENTORY, FACILITY_OPS,
  MEMBERSHIP_OPS, MEMBERSHIP_AUDIT, PROGRAM_OPS, REVENUE_OPS, FINANCE, SYSTEM_STATUS, SETTINGS, DEV_TOOLS,
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
  it("My Receipts holds a person's own receipts and the reimbursements waiting for their confirmation", () => {
    expect(MY_RECEIPTS.links.map((l) => l.href)).toEqual(["/receipts", "/receipts/upload", "/receipts/confirm"]);
  });

  it("To confirm shows to any adult, a lapsed member included, and to the Board, with a green pill", () => {
    const confirm = MY_RECEIPTS.links.find((l) => l.href === "/receipts/confirm")!;
    expect(confirm.visible?.({ ageBand: "adult", isActiveOrgMember: false }, counts)).toBe(true);
    expect(confirm.visible?.({ isBoardMember: true }, counts)).toBe(true);
    expect(confirm.visible?.({ ageBand: "youth" }, counts)).toBe(false);
    expect(confirm.badge?.({ ...counts, libraries: { receipt: { toConfirm: 1 } } })).toEqual({
      count: 1,
      color: "treehouseGreen",
      label: "1 receipt waits for your confirmation",
    });
    expect(confirm.badge?.(counts)).toBeNull();
  });

  it("My receipts carries a green pill for the receipts that wait on their uploader", () => {
    const list = MY_RECEIPTS.links.find((l) => l.href === "/receipts");
    expect(list?.badge?.({ ...counts, libraries: { receipt: { awaitingMe: 2 } } })).toEqual({
      count: 2,
      color: "treehouseGreen",
      label: "2 receipts need you",
    });
    expect(list?.badge?.(counts)).toBeNull();
  });

  it("Finance holds the queue, flow status, mail and the settings group for FINANCE or BOARD; mail for FINANCE alone", () => {
    const hrefs = (user: NavUser) => visibleLinks(FINANCE, user, counts).map((l) => l.href);
    expect(hrefs(PERSONAS.finance)).toEqual(expect.arrayContaining(["/finance/review", "/receipt-flow", "/receipts/mail", "/expense/settings"]));
    expect(hrefs(PERSONAS.board)).toEqual(expect.arrayContaining(["/finance/review", "/receipt-flow", "/expense/settings"]));
    expect(hrefs(PERSONAS.board)).not.toContain("/receipts/mail");
    expect(linkGate(FINANCE, "/receipts/settings")(PERSONAS.board, counts)).toBe(true);
    for (const name of ["member", "sysadmin", "operations"]) {
      expect(sectionShown(FINANCE, PERSONAS[name], counts)).toBe(false);
    }
  });

  it("Finance review carries a green pill for the receipts that wait on FINANCE", () => {
    const review = FINANCE.links.find((l) => l.href === "/finance/review");
    expect(review?.badge?.({ ...counts, libraries: { receipt: { awaitingFinance: 1 } } })).toEqual({
      count: 1,
      color: "treehouseGreen",
      label: "1 item waits on you in Finance review",
    });
    expect(review?.badge?.(counts)).toBeNull();
  });

  it("Inventory shows Flow status to an inventory manager, not to a catalog viewer or FINANCE", () => {
    const hrefs = (user: NavUser) => visibleLinks(INVENTORY, user, counts).map((l) => l.href);
    expect(hrefs(PERSONAS.inventoryManager).at(-1)).toBe("/receipt-flow");
    expect(hrefs(PERSONAS.keyholder)).toContain("/catalog/items");
    expect(hrefs(PERSONAS.keyholder)).not.toContain("/receipt-flow");
    expect(hrefs(PERSONAS.finance)).not.toContain("/receipt-flow");
  });
});

describe("Membership Ops", () => {
  it('calls the review page "Background-check Review"', () => {
    expect(MEMBERSHIP_OPS.links.find((l) => l.href === "/membership-ops/review")?.name).toBe("Background-check Review");
  });
});

// The sidebar reads a tab's badge function and the tab row reads tabBadgeFor first,
// so a tab with both would show different pills in the two places.
describe("tab badge sources", () => {
  const counts: TodoCounts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    admin: {
      membership: 1, applicationsTotal: 1, paymentPlanPending: 1, membershipPaymentPlanPending: 1, trustedAdults: 1, householdsMissingContact: 1,
      unclaimedHouseholds: 1, brokenHouseholds: 1, brokenEmails: 1, settingsMisconfig: 1, programsMisconfig: 1, openPaymentExceptions: 1,
    },
  };

  it("no tab or sub-tab has both a tabBadgeFor case and its own badge function", () => {
    const both = SECTIONS.flatMap((s) => s.links.flatMap((l) => [l, ...(l.subLinks ?? [])]))
      .filter((l) => l.badge && tabBadgeFor(l.href, counts))
      .map((l) => l.href);
    expect(both).toEqual([]);
  });
});

