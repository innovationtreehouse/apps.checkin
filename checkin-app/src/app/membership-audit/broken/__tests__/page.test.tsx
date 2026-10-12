// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import BrokenHouseholdsPage from "../page";

beforeEach(() => resetRtl());

describe("membership-audit/broken page", () => {
  pinTimezone();

  it("renders a UTC-midnight DOB as its own calendar day, not the day before", async () => {
    mockFetchJson({
      "/api/admin/broken-households": {
        households: [{ id: 1, name: "The Days", members: [{ id: 10, name: "Dee Day", dateOfBirth: "1990-08-15T00:00:00.000Z" }] }],
      },
    });
    const { container } = renderWithProviders(<BrokenHouseholdsPage />);
    await screen.findByText("Dee Day", { exact: false });

    expect(container.textContent).toContain("8/15/1990");
    expect(container.textContent).not.toContain("8/14/1990");
  });

  it("shows the empty state when there are no broken households", async () => {
    mockFetchJson({ "/api/admin/broken-households": { households: [] } });
    renderWithProviders(<BrokenHouseholdsPage />);

    expect(await screen.findByText("No broken households.")).toBeInTheDocument();
  });

  it("shows an error state (not a false all-clear) when the load fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    renderWithProviders(<BrokenHouseholdsPage />);

    expect(await screen.findByText("Couldn't load broken households.")).toBeInTheDocument();
    expect(screen.queryByText("No broken households.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    spy.mockRestore();
  });

  it("Retry clears the error state and shows the reloaded list", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    renderWithProviders(<BrokenHouseholdsPage />);
    await screen.findByText("Couldn't load broken households.");

    mockFetchJson({ "/api/admin/broken-households": { households: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No broken households.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load broken households.")).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
