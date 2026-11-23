// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import OneTimeEventsList from "../page";

beforeEach(() => resetRtl());

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const events = [
  { id: 1, name: "Future Woodshop", startAt: future, endAt: future, description: "Intro session" },
  { id: 2, name: "Past Woodshop", startAt: past, endAt: past, description: null },
];

describe("OneTimeEventsList", () => {
  pinTimezone("America/Chicago");

  it("loads and shows only future events by default", async () => {
    mockFetchJson({ "/api/events": events });
    renderWithProviders(<OneTimeEventsList />);

    expect(await screen.findByText("Future Woodshop")).toBeInTheDocument();
    expect(screen.queryByText("Past Woodshop")).not.toBeInTheDocument();
  });

  it("shows past events once Future Only is unchecked, and filters by search", async () => {
    mockFetchJson({ "/api/events": events });
    renderWithProviders(<OneTimeEventsList />);
    await screen.findByText("Future Woodshop");

    fireEvent.click(screen.getByLabelText("Future Only"));
    expect(await screen.findByText("Past Woodshop")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search events…"), { target: { value: "Future" } });
    expect(screen.getByText("Future Woodshop")).toBeInTheDocument();
    expect(screen.queryByText("Past Woodshop")).not.toBeInTheDocument();
  });

  it("formats event times in the org's zone, not the browser's", async () => {
    // 9:30 PM Aug 31 in Chicago, 11:30 AM Sep 1 in Tokyo.
    const at = "2030-09-01T02:30:00.000Z";
    mockFetchJson({ "/api/events": [{ id: 3, name: "Open House", startAt: at, endAt: at, description: null }] });
    renderWithProviders(<OneTimeEventsList />, {
      wrapper: ({ children }: { children: ReactNode }) => <TimezoneProvider value="Asia/Tokyo">{children}</TimezoneProvider>,
    });

    expect(await screen.findAllByText("Sep 1, 2030, 11:30 AM")).toHaveLength(2);
  });

  it("shows an empty state when there are no events", async () => {
    mockFetchJson({ "/api/events": [] });
    renderWithProviders(<OneTimeEventsList />);
    expect(await screen.findByText("No one-time events found.")).toBeInTheDocument();
  });

  it("shows the failure, not an empty list, when the load fails", async () => {
    mockFetchJson({});
    renderWithProviders(<OneTimeEventsList />);
    expect(await screen.findByText("Couldn't load one-time events")).toBeInTheDocument();
    expect(screen.queryByText("No one-time events found.")).not.toBeInTheDocument();
  });
});
