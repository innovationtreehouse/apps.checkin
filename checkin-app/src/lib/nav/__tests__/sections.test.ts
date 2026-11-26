import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavSection, NavUser } from "@/lib/nav/types";
import { hasAnyRole, linkGate, sectionShown, tabHrefs, visibleLinks } from "@/lib/nav/gates";
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
import { DONATIONS } from "@/lib/nav/sections/donations";
import { FINANCE } from "@/lib/nav/sections/finance";
import { SYSTEM_STATUS } from "@/lib/nav/sections/systemStatus";
import { SETTINGS } from "@/lib/nav/sections/settings";
import { DEV_TOOLS } from "@/lib/nav/sections/devTools";
import { tabBadgeFor } from "@/components/navBadges";

const SECTIONS: NavSection[] = [
  SAFETY, MY_ACTIVITIES, MY_RECEIPTS, PROGRAMS_I_LEAD, SHOP_OPS, INVENTORY, FACILITY_OPS,
  MEMBERSHIP_OPS, MEMBERSHIP_AUDIT, PROGRAM_OPS, REVENUE_OPS, FINANCE, DONATIONS, SYSTEM_STATUS, SETTINGS, DEV_TOOLS,
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

// The whole tab list per section, so a tab dropped by an edit or a bad merge fails here.
const TABS: Record<string, string[][]> = {
  safety: [["/safety/emergency-contacts"], ["/safety/board-contacts"], ["/safety/pickup"], ["/safety/trusted-adults"]],
  "my-activities": [["/my-activities/events"], ["/my-activities/programs"]],
  "my-receipts": [["/receipts"], ["/receipts/upload"], ["/receipts/confirm"]],
  "programs-i-lead": [
    ["/programs-i-lead/attendance"],
    ["/programs-i-lead/conflicts"],
    ["/programs-i-lead/expense-approvals"],
    ["/programs-i-lead/in-kind-gifts"],
  ],
  "shop-ops": [["/shop-ops/manage"], ["/shop-ops/create"], ["/shop-ops/live"]],
  inventory: [
    [
      "/catalog/items",
      "/catalog/items",
      "/catalog/categories",
      "/catalog/learned-references",
      "/catalog/provisional-items",
      "/catalog/item-reference-proposals",
      "/catalog/reference-conflicts",
      "/catalog/conversion-challenges",
    ],
    [
      "/inventory/org-items",
      "/inventory/org-items",
      "/inventory/unlocated",
      "/inventory/receive-queue",
      "/inventory/locations",
      "/inventory/provisional-items",
    ],
    ["/inventory/merge-conflicts", "/inventory/merge-conflicts", "/inventory/org-events", "/inventory/inventory-log"],
    ["/inventory/receiving"],
  ],
  "facility-ops": [
    ["/facility-ops/visits"],
    ["/facility-ops/badges"],
    ["/facility-ops/print-badges"],
    ["/facility-ops/trends"],
    ["/facility-ops/corrections"],
  ],
  "membership-ops": [
    ["/membership-ops/participants"],
    ["/membership-ops/participants/merge"],
    ["/membership-ops/households"],
    ["/membership-ops/volunteer-memberships"],
    ["/membership-ops/applications"],
    ["/membership-ops/review"],
    ["/membership-ops/roles"],
  ],
  "membership-audit": [
    ["/membership-audit/emergency-contacts"],
    ["/membership-audit/unclaimed"],
    ["/membership-audit/broken"],
    ["/membership-audit/compliance"],
    ["/membership-audit/bg-attestations"],
    ["/membership-audit/turning-18"],
  ],
  "program-ops": [["/program-ops/programs"], ["/program-ops/new"], ["/program-ops/events"], ["/program-ops/sessions"]],
  "revenue-ops": [
    ["/finance-ops/payment-plan"],
    ["/finance-ops/membership-payment-plan"],
    [
      "/finance-ops/shopify-holds",
      "/finance-ops/shopify-holds",
      "/finance-ops/payments",
      "/finance-ops/shopify-stock",
      "/income/payouts",
      "/income/reconciliation",
    ],
    ["/income", "/income/items", "/income/exclusions", "/income/settings"],
  ],
  finance: [
    ["/finance/review"],
    ["/expense/expenses"],
    ["/receipt-flow"],
    ["/expense/account-mapping"],
    ["/expense/qb-accounts"],
    ["/expense/ownership-map"],
    ["/expense/capital-seed"],
    ["/budgets"],
    ["/books-map"],
    ["/receipts/mail"],
    ["/receipts/settings"],
    ["/finance/mail-aliases"],
  ],
  donations: [
    [
      "/donations/uploads",
      "/donations/uploads",
      "/donations/transactions",
      "/donations/unassigned",
      "/donations/holds",
      "/donations/events",
      "/donations/comment-rules",
      "/donations/account-map",
    ],
    ["/donations/in-kind-gifts", "/donations/in-kind-gifts", "/donations/in-kind"],
  ],
  "system-status": [
    ["/system-status/health"],
    ["/system-status/links"],
    ["/system-status/lifecycle"],
    ["/system-status/errors"],
    ["/system-status/unsynced-scans"],
    ["/system-status/audit-log"],
    ["/system-status/finance-views"],
    ["/system-status/qbo-codes"],
  ],
  settings: [
    ["/settings/membership"],
    ["/settings/localization"],
    ["/settings/email"],
    ["/settings/templates"],
    ["/settings/outreach"],
    ["/settings/shopify-webhook"],
    ["/settings/finance"],
    ["/settings/receipt-reading"],
  ],
  dev: [["/dev/sent-mail"], ["/dev/zoho-sign"], ["/dev/shopify"], ["/dev/bg-consent"]],
};

it("every section keeps exactly its pinned tabs", () => {
  expect(Object.fromEntries(SECTIONS.map((s) => [s.id, s.links.map(tabHrefs)]))).toEqual(TABS);
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

  it("Finance holds the queue, flow status, mail and receipt settings for FINANCE or BOARD; mail for FINANCE alone", () => {
    const hrefs = (user: NavUser) => visibleLinks(FINANCE, user, counts).map((l) => l.href);
    expect(hrefs(PERSONAS.finance)).toEqual(expect.arrayContaining(["/finance/review", "/receipt-flow", "/receipts/mail", "/receipts/settings"]));
    expect(hrefs(PERSONAS.board)).toEqual(expect.arrayContaining(["/finance/review", "/receipt-flow", "/receipts/settings"]));
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

  it("Inventory has no Flow status tab: the flow status page lives in Finance", () => {
    for (const u of [PERSONAS.inventoryManager, PERSONAS.keyholder, PERSONAS.finance, PERSONAS.board]) {
      expect(visibleLinks(INVENTORY, u, counts).flatMap(tabHrefs)).not.toContain("/receipt-flow");
    }
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
      membership: 1, applicationsTotal: 1, applicationsIncomplete: 0, applicationsAwaitingRefund: 1, paymentPlanPending: 1, membershipPaymentPlanPending: 1, trustedAdults: 1, householdsMissingContact: 1,
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


describe("System Status sidebar link", () => {
  it("opens finance on QuickBooks codes, its only tab, and everyone else it admits on Health", () => {
    expect(SYSTEM_STATUS.hrefFor?.(PERSONAS.finance, null)).toBe("/system-status/qbo-codes");
    expect(SYSTEM_STATUS.hrefFor?.(PERSONAS.board, null)).toBe("/system-status/health");
    expect(SYSTEM_STATUS.hrefFor?.(PERSONAS.sysadmin, null)).toBe("/system-status/health");
  });
});
