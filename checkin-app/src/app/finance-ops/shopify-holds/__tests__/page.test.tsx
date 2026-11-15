type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen, fireEvent, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { readsOf, reconnectAfterDedupe, unrelatedWrite } from "@/test-helpers/loadReads";
import ShopifyHoldsPage from "../page";

const LIST = "/api/finance-ops/payment-plans?queue=holds";
const rows = [
  {
    programId: 10,
    personId: 20,
    pendingSince: "2026-01-01T00:00:00.000Z",
    person: { id: 20, name: "Pat Participant", email: "pat@example.com", householdId: 5 },
    program: { id: 10, name: "Robotics" },
  },
];

beforeEach(() => {
  resetRtl();
  setSession({ id: 1, isBoardMember: true });
});
afterEach(() => jest.useRealTimers());

describe("finance-ops/shopify-holds page", () => {
  it("reads the queue once on mount and not again on reconnect", async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetchJson({ [LIST]: { ProgramParticipant: rows } });
    renderWithProviders(<ShopifyHoldsPage />);
    expect(await screen.findByText("Pat Participant")).toBeInTheDocument();

    await reconnectAfterDedupe();
    expect(readsOf(fetchMock, LIST)).toHaveLength(1);
  });

  it("does not re-read after another page's write", async () => {
    const fetchMock = mockFetchJson({ [LIST]: { ProgramParticipant: rows }, "/api/unrelated": {} });
    renderWithProviders(<ShopifyHoldsPage />);
    await screen.findByText("Pat Participant");

    await unrelatedWrite();
    expect(readsOf(fetchMock, LIST)).toHaveLength(1);
  });

  it("confirms a manual hold with one POST, then re-reads the queue once", async () => {
    let held = false;
    const fetchMock = mockFetchJson({
      "/api/finance-ops/payment-plans/manual-hold": () => { held = true; return { success: true }; },
      [LIST]: () => ({ ProgramParticipant: held ? [] : rows }),
    });
    renderWithProviders(<ShopifyHoldsPage />);
    await screen.findByText("Pat Participant");

    fireEvent.click(screen.getByRole("button", { name: "Confirm manual hold" }));
    const modal = await screen.findByRole("dialog", { name: "Confirm manual seat hold" });
    fireEvent.click(within(modal).getByRole("button", { name: /confirm/ }));

    expect(await screen.findByText("No failed seat holds to reconcile.")).toBeInTheDocument();
    expect(readsOf(fetchMock, LIST)).toHaveLength(2);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ programId: 10, participantId: 20 });
  });

  it("shows a failed load in place of the table, not an empty list", async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ error: "Server down" }), { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<ShopifyHoldsPage />);

    expect(await screen.findByText(/Server down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry|try again/i })).toBeInTheDocument();
    expect(screen.queryByText("No failed seat holds to reconcile.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
