type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { readsOf, reconnectAfterDedupe, unrelatedWrite } from "@/test-helpers/loadReads";
import MembershipPaymentPlansPage from "../page";

const LIST = "/api/finance-ops/membership-payment-plans";

beforeEach(() => {
  resetRtl();
  setSession({ id: 1, isBoardMember: true });
});
afterEach(() => jest.useRealTimers());

const requests = [
  {
    id: 1,
    stageEnteredAt: "2026-01-15T00:00:00.000Z",
    orgMembership: {
      isVolunteerFamily: false,
      household: {
        id: 1,
        name: "Smith Family",
        householdMembers: [{ id: 10, name: "Jane Smith", email: "jane@example.com" }],
      },
    },
  },
];

describe("finance-ops/membership-payment-plan page", () => {
  it("renders household name and lead email", async () => {
    mockFetchJson({ [LIST]: requests });
    renderWithProviders(<MembershipPaymentPlansPage />);

    expect(await screen.findByText("Smith Family")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });

  it("reads the list once on mount and not again on reconnect", async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetchJson({ [LIST]: requests });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    await reconnectAfterDedupe();
    expect(readsOf(fetchMock, LIST)).toHaveLength(1);
  });

  it("does not re-read after another page's write", async () => {
    const fetchMock = mockFetchJson({ [LIST]: requests, "/api/unrelated": {} });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    await unrelatedWrite();
    expect(readsOf(fetchMock, LIST)).toHaveLength(1);
  });

  it("denies a request, then re-reads the list once and shows it without the row", async () => {
    let denied = false;
    const fetchMock = mockFetchJson({
      [`${LIST}/refuse`]: () => { denied = true; return { success: true }; },
      [LIST]: () => (denied ? [] : requests),
    });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    const modal = await screen.findByRole("dialog", { name: "Deny Scholarship / Payment Plan" });
    fireEvent.click(within(modal).getByRole("button", { name: "Deny" }));

    expect(await screen.findByText("No pending membership scholarship or payment plan requests.")).toBeInTheDocument();
    expect(readsOf(fetchMock, LIST)).toHaveLength(2);
  });

  it("shows a failed load in place of the table, not an empty list", async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ error: "Server down" }), { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<MembershipPaymentPlansPage />);

    expect(await screen.findByText(/Server down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry|try again/i })).toBeInTheDocument();
    expect(screen.queryByText("No pending membership scholarship or payment plan requests.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
