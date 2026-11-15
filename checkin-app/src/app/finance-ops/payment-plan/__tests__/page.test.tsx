type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { readsOf, reconnectAfterDedupe, unrelatedWrite } from "@/test-helpers/loadReads";
import PendingParticipantsPage from "../page";

const LIST = "/api/finance-ops/payment-plans";

beforeEach(() => resetRtl());
afterEach(() => jest.useRealTimers());

const requests = [
  {
    programId: 10,
    personId: 20,
    pendingSince: "2026-01-01T00:00:00.000Z",
    person: {
      id: 20, name: "Pat Participant", email: "pat@example.com",
      household: {
        id: 1, name: "Participant Family",
        householdMembers: [{ id: 30, name: "Lead Parent", email: "lead@example.com" }],
      },
    },
    program: { id: 10, name: "Robotics", orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 7500 },
  },
];

describe("finance-ops/payment-plan page", () => {
  it("loads and renders pending payment plan requests", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/finance-ops/payment-plans": { ProgramParticipant: requests, BoardSettings: null } });
    renderWithProviders(<PendingParticipantsPage />);

    expect(await screen.findByText("Pat Participant")).toBeInTheDocument();
    expect(screen.getByText("pat@example.com")).toBeInTheDocument();
    expect(screen.getByText("lead@example.com")).toBeInTheDocument();
    expect(screen.getByText("Robotics")).toBeInTheDocument();
    expect(screen.getByText(/M \$50.00 \/ NM \$75.00/)).toBeInTheDocument();
  });

  it("approves a request, then re-reads the list once and shows it without the row", async () => {
    setSession({ id: 1, isBoardMember: true });
    let approved = false;
    const fetchMock = mockFetchJson({
      [LIST]: () => {
        if (fetchMock.mock.calls.at(-1)?.[1]?.method === "POST") approved = true;
        return { ProgramParticipant: approved ? [] : requests, BoardSettings: null };
      },
    });
    renderWithProviders(<PendingParticipantsPage />);
    await screen.findByText("Pat Participant");

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));

    const confirmModal = await screen.findByRole("dialog", { name: "Approve Scholarship / Payment Plan" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: /Approve/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/finance-ops/payment-plans",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ programId: 10, participantId: 20 }),
        }),
      ),
    );
    expect(await screen.findByText("No pending scholarship or payment plan requests.")).toBeInTheDocument();
    expect(readsOf(fetchMock, LIST)).toHaveLength(2);
  });

  it("keeps the row's buttons disabled while an approve is in flight, so it sends once", async () => {
    setSession({ id: 1, isBoardMember: true });
    let approved = false;
    const list = mockFetchJson({
      [LIST]: () => ({ ProgramParticipant: approved ? [] : requests, BoardSettings: null }),
    });
    let answer: (res: Response) => void = () => {};
    const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? new Promise<Response>((resolve) => { answer = resolve; }) : list(input, init),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<PendingParticipantsPage />);
    await screen.findByText("Pat Participant");

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    const confirmModal = await screen.findByRole("dialog", { name: "Approve Scholarship / Payment Plan" });
    fireEvent.click(within(confirmModal).getByRole("button", { name: /Approve/ }));

    const rowApprove = await screen.findByRole("button", { name: /Approve & Mark Active/ });
    await waitFor(() => expect(rowApprove).toBeDisabled());
    expect(screen.getByRole("button", { name: "Refuse" })).toBeDisabled();
    fireEvent.click(rowApprove);
    expect(screen.queryByRole("dialog", { name: "Approve Scholarship / Payment Plan" })).not.toBeInTheDocument();

    approved = true;
    answer(new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await screen.findByText("No pending scholarship or payment plan requests.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
  });

  it("reads the list once on mount and not again on reconnect", async () => {
    jest.useFakeTimers();
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({ [LIST]: { ProgramParticipant: requests, BoardSettings: null } });
    renderWithProviders(<PendingParticipantsPage />);
    await screen.findByText("Pat Participant");

    await reconnectAfterDedupe();
    expect(readsOf(fetchMock, LIST)).toHaveLength(1);
  });

  it("does not re-read after another page's write", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({ [LIST]: { ProgramParticipant: requests, BoardSettings: null }, "/api/unrelated": {} });
    renderWithProviders(<PendingParticipantsPage />);
    await screen.findByText("Pat Participant");

    await unrelatedWrite();
    expect(readsOf(fetchMock, LIST)).toHaveLength(1);
  });

  it("shows a failed load in place of the table, not an empty list", async () => {
    setSession({ id: 1, isBoardMember: true });
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })) as unknown as typeof fetch;
    renderWithProviders(<PendingParticipantsPage />);

    expect(await screen.findByText(/Forbidden/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry|try again/i })).toBeInTheDocument();
    expect(screen.queryByText("No pending scholarship or payment plan requests.")).not.toBeInTheDocument();
  });
});
