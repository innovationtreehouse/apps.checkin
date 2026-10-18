jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { waitFor } from "@testing-library/react";
import { renderWithProviders, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { visibleLinks } from "@/lib/nav/gates";
import { FINANCE_NAV_LINKS, REVENUE_OPS } from "@/lib/nav/sections/revenueOps";
import PaymentPlanPage from "../payment-plan/page";
import MembershipPaymentPlanPage from "../membership-payment-plan/page";
import ShopifyHoldsPage from "../shopify-holds/page";
import PaymentsPage from "../payments/page";
import UnconfirmedShopifyStockPage from "../shopify-stock/page";

beforeEach(() => resetRtl());

// Revenue Ops admits FINANCE, but each Board-only finance page keeps its own
// Board gate, so a FINANCE-only user who types the URL is refused.
describe.each([
  ["/finance-ops/payment-plan", PaymentPlanPage],
  ["/finance-ops/membership-payment-plan", MembershipPaymentPlanPage],
  ["/finance-ops/shopify-holds", ShopifyHoldsPage],
  ["/finance-ops/payments", PaymentsPage],
  ["/finance-ops/shopify-stock", UnconfirmedShopifyStockPage],
])("%s", (href, Page) => {
  it("is a Revenue Ops legacy tab", () => {
    expect(FINANCE_NAV_LINKS.map((l) => l.href)).toContain(href);
  });

  it("refuses a FINANCE-only user by URL", async () => {
    setSession({ id: 2, isFinance: true });
    const fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("no network in tests"));
    renderWithProviders(<Page />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((url) => url.includes("/api/finance-ops"))).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("refuses a sysadmin (board-only, #1083)", async () => {
    setSession({ id: 3, isSysadmin: true });
    renderWithProviders(<Page />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });
});

describe("Revenue Ops tabs", () => {
  it("hides the legacy tabs from FINANCE-only and shows them to Board", () => {
    expect(visibleLinks(REVENUE_OPS, { isFinance: true }, null)).toEqual([]);
    expect(visibleLinks(REVENUE_OPS, { isBoardMember: true }, null).map((t) => t.href)).toEqual([...FINANCE_NAV_LINKS.map((l) => l.href), "/income", "/donations"]);
    expect(visibleLinks(REVENUE_OPS, { isSysadmin: true }, null)).toEqual([]);
  });
});
