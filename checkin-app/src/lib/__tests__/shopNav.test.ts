import { visibleLinks } from "@/lib/nav/gates";
import { SHOP_OPS, shopRoles, defaultShopTab } from "@/lib/nav/sections/shopOps";
import type { Session } from "next-auth";

type SessionUser = Session["user"];

const user = (overrides: Partial<SessionUser> = {}): SessionUser =>
  ({ id: 1, ...overrides }) as SessionUser;

describe("SHOP_OPS links", () => {
  it("lists the three shop-ops tabs", () => {
    expect(SHOP_OPS.links.map((l) => l.href)).toEqual([
      "/shop-ops/manage",
      "/shop-ops/create",
      "/shop-ops/live",
    ]);
  });
});

describe("shopRoles", () => {
  it("treats sysadmins as admin and certifier", () => {
    expect(shopRoles(user({ isSysadmin: true }))).toEqual({ isAdmin: true, isCertifier: true });
  });

  it("treats board members as admin and certifier", () => {
    expect(shopRoles(user({ isBoardMember: true }))).toEqual({ isAdmin: true, isCertifier: true });
  });

  it("grants certifier (not admin) to a non-admin with a MAY_CERTIFY_OTHERS tool status", () => {
    expect(
      shopRoles(user({ toolStatuses: [{ toolId: 1, level: "MAY_CERTIFY_OTHERS" }] })),
    ).toEqual({ isAdmin: false, isCertifier: true });
  });

  it("does not grant certifier for a lesser tool status", () => {
    expect(
      shopRoles(user({ toolStatuses: [{ toolId: 1, level: "BASIC" }] })),
    ).toEqual({ isAdmin: false, isCertifier: false });
  });

  it("denies both for a plain member with no roles or certifications", () => {
    expect(shopRoles(user())).toEqual({ isAdmin: false, isCertifier: false });
  });

  it("denies both when there is no session user", () => {
    expect(shopRoles(undefined)).toEqual({ isAdmin: false, isCertifier: false });
  });
});

describe("SHOP_OPS tab visibility by role", () => {
  it("shows all three tabs to an admin", () => {
    const visible = visibleLinks(SHOP_OPS, user({ isSysadmin: true }), null).map((l) => l.name);
    expect(visible).toEqual([
      "Manage Tools & Certifications",
      "Create Tool",
      "Live Certifications Center",
    ]);
  });

  it("hides Create Tool from a certifier who isn't an admin", () => {
    const visible = visibleLinks(SHOP_OPS, user({ toolStatuses: [{ toolId: 1, level: "MAY_CERTIFY_OTHERS" }] }), null).map((l) => l.name);
    expect(visible).toEqual(["Manage Tools & Certifications", "Live Certifications Center"]);
  });

  it("shows no tab to a plain member, whom the section does not admit", () => {
    expect(visibleLinks(SHOP_OPS, user(), null)).toEqual([]);
    expect(SHOP_OPS.visible(user(), null)).toBe(false);
  });
});

describe("defaultShopTab", () => {
  it("lands certifiers (including admins) on Manage", () => {
    expect(defaultShopTab({ isAdmin: true, isCertifier: true })).toBe("/shop-ops/manage");
    expect(defaultShopTab({ isAdmin: false, isCertifier: true })).toBe("/shop-ops/manage");
  });

  it("lands everyone else on Live", () => {
    expect(defaultShopTab({ isAdmin: false, isCertifier: false })).toBe("/shop-ops/live");
  });
});
