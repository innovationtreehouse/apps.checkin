jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, waitFor } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { visibleLinks } from "@/lib/nav/gates";
import { FINANCE_NAV_LINKS, REVENUE_OPS, SHOPIFY_NAV_LINKS } from "@/lib/nav/sections/revenueOps";
import PaymentPlanPage from "../payment-plan/page";
import MembershipPaymentPlanPage from "../membership-payment-plan/page";
import ShopifyHoldsPage from "../shopify-holds/page";
import PaymentsPage from "../payments/page";
import UnconfirmedShopifyStockPage from "../shopify-stock/page";

beforeEach(() => resetRtl());

// Revenue Ops admits FINANCE, but each Board-only finance page keeps its own
// Board gate, so a FINANCE-only user who types the URL is refused.
describe.each([
  ["/finance-ops/shopify-holds", ShopifyHoldsPage],
  ["/finance-ops/payments", PaymentsPage],
  ["/finance-ops/shopify-stock", UnconfirmedShopifyStockPage],
])("%s", (href, Page) => {
  it("is a Revenue Ops legacy tab", () => {
    expect([...FINANCE_NAV_LINKS, ...SHOPIFY_NAV_LINKS].map((l) => l.href)).toContain(href);
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

  it("refuses a sysadmin (board-only)", async () => {
    setSession({ id: 3, isSysadmin: true });
    renderWithProviders(<Page />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });
});

const programRequest = {
  programId: 10,
  personId: 20,
  pendingSince: "2026-01-01T00:00:00.000Z",
  scholarshipRequestKind: null,
  person: { id: 20, name: "Pat Participant", email: "pat@example.com", householdId: 1, household: null },
  program: { id: 10, name: "Robotics", orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 7500, startAt: null },
};
const membershipRequest = {
  id: 1,
  stageEnteredAt: "2026-01-15T00:00:00.000Z",
  scholarshipRequestKind: null,
  orgMembership: { isVolunteerFamily: false, household: { id: 1, name: "Smith Family", householdMembers: [] } },
};

// Finance reads the payment-plan queues; the decision routes are Board-only.
describe.each([
  ["/finance-ops/payment-plan", PaymentPlanPage, "/api/finance-ops/payment-plans", { ProgramParticipant: [programRequest] }, "Pat Participant"],
  ["/finance-ops/membership-payment-plan", MembershipPaymentPlanPage, "/api/finance-ops/membership-payment-plans", [membershipRequest], "Smith Family"],
])("%s", (href, Page, api, body, rowText) => {
  it("is a Revenue Ops tab FINANCE-only and Board can both see", () => {
    for (const user of [{ isFinance: true }, { isBoardMember: true }]) {
      expect(visibleLinks(REVENUE_OPS, user, null).map((l) => l.href)).toContain(href);
    }
  });

  it("shows FINANCE-only the queue with no decision controls", async () => {
    setSession({ id: 2, isFinance: true });
    mockFetchJson({ [api]: body });
    renderWithProviders(<Page />);
    expect(await screen.findByText(rowText)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Refuse|Deny/ })).not.toBeInTheDocument();
  });

  it("shows Board the queue with its decision controls", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ [api]: body });
    renderWithProviders(<Page />);
    expect(await screen.findByText(rowText)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refuse|Deny/ })).toBeInTheDocument();
  });

  it("refuses a sysadmin", async () => {
    setSession({ id: 3, isSysadmin: true });
    renderWithProviders(<Page />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });
});

describe("Revenue Ops tabs", () => {
  it("shows FINANCE-only the payment-plan tabs and Board every legacy tab", () => {
    expect(visibleLinks(REVENUE_OPS, { isFinance: true }, null).map((t) => t.href)).toEqual(["/finance-ops/payment-plan", "/finance-ops/membership-payment-plan"]);
    expect(visibleLinks(REVENUE_OPS, { isBoardMember: true }, null).map((t) => t.href)).toEqual([...FINANCE_NAV_LINKS.map((l) => l.href), "/income/items"]);
    expect(visibleLinks(REVENUE_OPS, { isSysadmin: true }, null)).toEqual([]);
  });
});
