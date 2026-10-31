// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import OneTimeEventsList from "../page";

beforeEach(() => resetRtl());

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const events = [
  { id: 1, name: "Future Woodshop", startAt: future, endAt: future, description: "Intro session" },
  { id: 2, name: "Past Woodshop", startAt: past, endAt: past, description: null },
];

describe("OneTimeEventsList", () => {
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
