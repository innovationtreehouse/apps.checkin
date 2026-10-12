// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import UnclaimedHouseholdsIndex from "../page";

beforeEach(() => resetRtl());

describe("membership-audit/unclaimed page", () => {
  it("shows the empty state when there are no unclaimed households", async () => {
    mockFetchJson({ "/api/membership-audit/unclaimed-households": { households: [] } });
    renderWithProviders(<UnclaimedHouseholdsIndex />);

    expect(await screen.findByText("No unclaimed accounts.")).toBeInTheDocument();
  });

  it("shows an error state (not a false all-clear) when the load fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    renderWithProviders(<UnclaimedHouseholdsIndex />);

    expect(await screen.findByText("Couldn't load unclaimed households.")).toBeInTheDocument();
    expect(screen.queryByText("No unclaimed accounts.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    spy.mockRestore();
  });

  it("Retry clears the error state and shows the reloaded list", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    renderWithProviders(<UnclaimedHouseholdsIndex />);
    await screen.findByText("Couldn't load unclaimed households.");

    mockFetchJson({ "/api/membership-audit/unclaimed-households": { households: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No unclaimed accounts.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load unclaimed households.")).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
