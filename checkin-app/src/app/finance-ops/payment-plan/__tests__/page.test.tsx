// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import PendingParticipantsPage from "../page";

beforeEach(() => resetRtl());

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

  it("approves a request and removes it from the list", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({
      "/api/finance-ops/payment-plans": () => ({ ProgramParticipant: requests, BoardSettings: null }),
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
  });
});
