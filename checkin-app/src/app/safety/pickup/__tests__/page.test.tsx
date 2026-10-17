// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import TrustedAdultPickupPage from "../page";

beforeEach(() => resetRtl());

describe("safety/pickup page", () => {
  it("loads and renders approved trusted adults", async () => {
    mockFetchJson({
      "/api/trusted-adults/operational": {
        trustedAdults: [
          {
            id: 1,
            householdId: 5,
            trustedAdultName: "Gary Guardian",
            trustedAdultPhone: "5551234567",
            trustedAdultEmail: "gary@example.com",
            household: { id: 5, name: "Guardian House" },
            reviews: [{ id: 9, status: "APPROVED", sharedNote: "May pick up Bobby.", reviewBy: "2026-01-01T00:00:00.000Z" }],
          },
        ],
      },
    });
    renderWithProviders(<TrustedAdultPickupPage />);

    expect(await screen.findByText("Gary Guardian")).toBeInTheDocument();
    expect(screen.getByText("for Guardian House")).toBeInTheDocument();
    expect(screen.getByText("May pick up Bobby.")).toBeInTheDocument();
  });

  it("shows the empty state with no approved adults", async () => {
    mockFetchJson({ "/api/trusted-adults/operational": { trustedAdults: [] } });
    renderWithProviders(<TrustedAdultPickupPage />);

    expect(await screen.findByText("No approved trusted adults to show.")).toBeInTheDocument();
  });

  it("shows an error state (not a false empty) when the load fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    renderWithProviders(<TrustedAdultPickupPage />);

    expect(await screen.findByText("Couldn't load the pickup list.")).toBeInTheDocument();
    expect(screen.queryByText("No approved trusted adults to show.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    spy.mockRestore();
  });
});
