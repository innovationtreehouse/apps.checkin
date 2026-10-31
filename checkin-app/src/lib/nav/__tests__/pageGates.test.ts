import { PAGES } from "@/components/pageRegistry";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import { ROLE_FLAGS, type RoleFlag } from "@/lib/roles";
import { linkGate } from "@/lib/nav/gates";
import { FINANCE, FINANCE_ROLES } from "@/lib/nav/sections/finance";
import { MEMBERSHIP_OPS, MEMBERSHIP_OPS_ADMIN_ROLES } from "@/lib/nav/sections/membershipOps";
import { NEW_PROGRAM_ROLES, PROGRAM_OPS } from "@/lib/nav/sections/programOps";
import { SAFETY, SAFETY_ROLES, TRUSTED_ADULTS_ROLES } from "@/lib/nav/sections/safety";
import { LOCALIZATION_ROLES, SETTINGS, SETTINGS_ADMIN_ROLES, SETTINGS_ROLES } from "@/lib/nav/sections/settings";
import type { NavGate, NavUser } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";

const pageGate = (href: string): NavGate => {
  const page = PAGES.find((p) => p.href === href);
  if (!page) throw new Error(`${href} is not in PAGES`);
  return page.visible;
};

const released = { releasedLibraries: [...LIBRARY_KEYS] } as TodoCounts;
const flags = ROLE_FLAGS;
const personas: NavUser[] = [{}, ...flags.map((flag) => ({ [flag]: true }))];
const admitted = (test: (user: NavUser) => boolean) => flags.filter((_, i) => test(personas[i + 1]));

// Each page passes `roles` to useRequireRole; the nav shows it by `gate`.
const CASES: Array<[string, readonly RoleFlag[], NavGate]> = [
  ["/books-map", FINANCE_ROLES, linkGate(FINANCE, "/books-map")],
  ["/budgets", FINANCE_ROLES, linkGate(FINANCE, "/budgets")],
  ["/finance/mail-aliases", FINANCE_ROLES, linkGate(FINANCE, "/finance/mail-aliases")],
  ["/membership-ops/households", MEMBERSHIP_OPS_ADMIN_ROLES, linkGate(MEMBERSHIP_OPS, "/membership-ops/households")],
  // A detail page has no descriptor of its own; it takes its parent tab's gate.
  ["/membership-ops/households/[id]", MEMBERSHIP_OPS_ADMIN_ROLES, linkGate(MEMBERSHIP_OPS, "/membership-ops/households")],
  ["/membership-ops/participants/merge", MEMBERSHIP_OPS_ADMIN_ROLES, linkGate(MEMBERSHIP_OPS, "/membership-ops/participants/merge")],
  ["/membership-ops/participants/new", MEMBERSHIP_OPS_ADMIN_ROLES, pageGate("/membership-ops/participants/new")],
  ["/membership-ops/participants/tombstones", MEMBERSHIP_OPS_ADMIN_ROLES, pageGate("/membership-ops/participants/tombstones")],
  ["/membership-ops/roles", MEMBERSHIP_OPS_ADMIN_ROLES, linkGate(MEMBERSHIP_OPS, "/membership-ops/roles")],
  ["/membership-ops/volunteer-memberships", MEMBERSHIP_OPS_ADMIN_ROLES, linkGate(MEMBERSHIP_OPS, "/membership-ops/volunteer-memberships")],
  ["/program-ops/new", NEW_PROGRAM_ROLES, linkGate(PROGRAM_OPS, "/program-ops/new")],
  ["/safety/board-contacts", SAFETY_ROLES, linkGate(SAFETY, "/safety/board-contacts")],
  ["/safety/emergency-contacts", SAFETY_ROLES, linkGate(SAFETY, "/safety/emergency-contacts")],
  ["/safety/trusted-adults", TRUSTED_ADULTS_ROLES, linkGate(SAFETY, "/safety/trusted-adults")],
  ["/settings/email", SETTINGS_ADMIN_ROLES, linkGate(SETTINGS, "/settings/email")],
  ["/settings/localization", LOCALIZATION_ROLES, linkGate(SETTINGS, "/settings/localization")],
  ["/settings/outreach", SETTINGS_ROLES, linkGate(SETTINGS, "/settings/outreach")],
  ["/settings/shopify-webhook", SETTINGS_ADMIN_ROLES, linkGate(SETTINGS, "/settings/shopify-webhook")],
];

describe.each(CASES)("%s", (_href, roles, gate) => {
  it("admits the roles its nav gate admits", () => {
    expect(admitted((u) => gate(u, released)).sort()).toEqual([...roles].sort());
  });

  it("refuses a signed-in user with no role", () => {
    expect(gate(personas[0], released)).toBe(false);
  });
});
