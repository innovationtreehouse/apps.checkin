/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { withAppItems } from "../appItems";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    program: { findMany: jest.fn() },
    boardSettings: { findUnique: jest.fn() },
    membershipYearVariant: { findMany: jest.fn() },
  },
}));

const db = jest.mocked(prisma, { shallow: false });

function hold(data: {
  programs?: { name: string; shopifyVariantId: string | null; claimantShopifyVariantId: string | null }[];
  years?: { shopifyVariantId: string; membershipYear: number }[];
  orgVariant?: string | null;
}) {
  (db.program.findMany as jest.Mock).mockResolvedValue(data.programs ?? []);
  (db.membershipYearVariant.findMany as jest.Mock).mockResolvedValue(data.years ?? []);
  (db.boardSettings.findUnique as jest.Mock).mockResolvedValue({
    orgMembershipVariantId: data.orgVariant ?? null,
    orgMembershipYearBoundary: new Date("2026-07-01T00:00:00Z"),
  });
}

const titles = (items: { variantId: string; title: string }[]) => Object.fromEntries(items.map((i) => [i.variantId, i.title]));

beforeEach(() => jest.clearAllMocks());

describe("withAppItems", () => {
  it("adds unsold program and membership items under readable names", async () => {
    hold({
      programs: [{ name: "Robotics", shopifyVariantId: "11", claimantShopifyVariantId: "12" }],
      years: [{ shopifyVariantId: "21", membershipYear: 2026 }],
    });
    const items = await withAppItems([]);
    expect(titles(items)).toMatchObject({ "11": "Robotics", "12": "Robotics (reserved seat)", "21": "Membership 2026-2027" });
    expect(items.every((i) => i.sku === null)).toBe(true);
  });

  it("names the org membership variant setting by its live year", async () => {
    hold({ orgVariant: "31" });
    const items = await withAppItems([]);
    expect(titles(items)["31"]).toMatch(/^Membership \d{4}-\d{4}$/);
  });

  it("skips a program with no variant", async () => {
    hold({ programs: [{ name: "Unsold", shopifyVariantId: null, claimantShopifyVariantId: null }] });
    expect(titles(await withAppItems([]))).not.toHaveProperty("null");
  });

  it("lists a sold item once, under the store's own title and SKU", async () => {
    hold({ programs: [{ name: "Robotics", shopifyVariantId: "11", claimantShopifyVariantId: null }] });
    const items = await withAppItems([{ variantId: "11", title: "Store title", sku: "SKU-1" }]);
    expect(items.filter((i) => i.variantId === "11")).toEqual([{ variantId: "11", title: "Store title", sku: "SKU-1" }]);
  });

  it("names a sold item whose line has no title", async () => {
    hold({ programs: [{ name: "Robotics", shopifyVariantId: "11", claimantShopifyVariantId: null }] });
    const items = await withAppItems([{ variantId: "11", title: null, sku: null }]);
    expect(titles(items)["11"]).toBe("Robotics");
  });

  it("lists a stored gid under the numeric id the mirror's order lines carry", async () => {
    hold({ programs: [{ name: "Robotics", shopifyVariantId: "gid://shopify/ProductVariant/11", claimantShopifyVariantId: null }] });
    const items = await withAppItems([{ variantId: "11", title: "Store title", sku: null }]);
    expect(items.map((i) => i.variantId).filter((v) => v.endsWith("11"))).toEqual(["11"]);
  });
});
