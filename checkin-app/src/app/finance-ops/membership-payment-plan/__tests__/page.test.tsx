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

const rows = [
  {
    id: 1,
    stageEnteredAt: "2026-01-15T00:00:00.000Z",
    paymentPlanYear: 2026,
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
const BOUNDARY = { orgMembershipYearBoundary: "2000-09-01T00:00:00.000Z" };
const requests = { OrgMembershipProcess: rows, BoardSettings: BOUNDARY };

describe("finance-ops/membership-payment-plan page", () => {
  it("renders household name and lead email", async () => {
    mockFetchJson({ [LIST]: requests });
    renderWithProviders(<MembershipPaymentPlansPage />);

    expect(await screen.findByText("Smith Family")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });

  it("shows the membership year on the row and in the approve dialog", async () => {
    mockFetchJson({ [LIST]: requests });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    expect(screen.getByText("2026-2027")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve & Activate" }));
    const modal = await screen.findByRole("dialog", { name: "Approve Scholarship / Payment Plan" });
    expect(within(modal).getByText("Membership year: 2026-2027")).toBeInTheDocument();
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
      [LIST]: () => (denied ? { ...requests, OrgMembershipProcess: [] } : requests),
    });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    const modal = await screen.findByRole("dialog", { name: "Deny Scholarship / Payment Plan" });
    fireEvent.click(within(modal).getByRole("button", { name: "Deny" }));

    expect(await screen.findByText("No pending membership scholarship or payment plan requests.")).toBeInTheDocument();
    expect(readsOf(fetchMock, LIST)).toHaveLength(2);
  });

  it("disables Approve for a request whose year has ended, with the reason", async () => {
    jest.useFakeTimers({ now: new Date("2027-09-02T00:00:00Z"), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout"] });
    mockFetchJson({ [LIST]: requests });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    const approve = screen.getByRole("button", { name: "Approve & Activate" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("title", expect.stringContaining("2026-2027, which has ended"));
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it("keeps Approve enabled while the request's year is current", async () => {
    jest.useFakeTimers({ now: new Date("2027-08-31T00:00:00Z"), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout"] });
    mockFetchJson({ [LIST]: requests });
    renderWithProviders(<MembershipPaymentPlansPage />);
    await screen.findByText("Smith Family");

    expect(screen.getByRole("button", { name: "Approve & Activate" })).toBeEnabled();
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
