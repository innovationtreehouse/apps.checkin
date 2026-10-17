// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import MembershipPaymentPlansPage from "../page";

beforeEach(() => resetRtl());

const requests = [
  {
    id: 1,
    stageEnteredAt: "2026-01-15T00:00:00.000Z",
    orgMembership: {
      isVolunteer: false,
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
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/finance-ops/membership-payment-plans": requests });
    renderWithProviders(<MembershipPaymentPlansPage />);

    expect(await screen.findByText("Smith Family")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });
});
