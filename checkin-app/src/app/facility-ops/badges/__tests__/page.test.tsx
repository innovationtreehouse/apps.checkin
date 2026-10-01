// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import AdminBadgesPage from "../page";

beforeEach(() => resetRtl());

describe("facility-ops/badges page", () => {
  it("loads and renders badge scan events", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/facility/badges": {
        badges: [{ id: 1, timestamp: "2026-01-01T14:00:00.000Z", person: { name: "Val Volunteer", email: "val@example.com" }, location: "Side Door" }],
      },
    });
    renderWithProviders(<AdminBadgesPage />);

    expect(await screen.findByText("Val Volunteer")).toBeInTheDocument();
    expect(screen.getByText("val@example.com")).toBeInTheDocument();
    expect(screen.getByText("Side Door")).toBeInTheDocument();
  });

  // The raw badge-event log is one person's record, not the aggregate — #1633
  // keeps operations out of it, and the API agrees.
  it("redirects an operations user", async () => {
    setSession({ id: 5, isOperations: true });
    mockFetchJson({ "/api/facility/badges": { badges: [] } });
    renderWithProviders(<AdminBadgesPage />);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });

  // The layout gate and GET /api/facility/badges both admit board, and
  // useRequireRole has no implicit fallthrough — omitting isBoardMember here
  // bounced a board member off a page the API serves them. Unrelated to the
  // operations grant; the bug predates it.
  it("admits a board member (matches the layout gate and the API)", async () => {
    setSession({ id: 3, isBoardMember: true });
    mockFetchJson({
      "/api/facility/badges": {
        badges: [{ id: 1, timestamp: "2026-01-01T14:00:00.000Z", person: { name: "Val Volunteer", email: "val@example.com" }, location: "Side Door" }],
      },
    });
    renderWithProviders(<AdminBadgesPage />);

    expect(await screen.findByText("Val Volunteer")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("filters rows by name, email, or location", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/facility/badges": {
        badges: [
          { id: 1, timestamp: "2026-01-01T14:00:00.000Z", person: { name: "Val Volunteer", email: "val@example.com" }, location: "Side Door" },
          { id: 2, timestamp: "2026-01-01T15:00:00.000Z", person: { name: "Pat Parent", email: "pat@example.com" }, location: "Shop" },
        ],
      },
    });
    renderWithProviders(<AdminBadgesPage />);

    await screen.findByText("Val Volunteer");
    const input = screen.getByPlaceholderText("Filter by name, email, location, or ID...");
    fireEvent.change(input, { target: { value: "shop" } });
    expect(screen.queryByText("Val Volunteer")).not.toBeInTheDocument();
    expect(screen.getByText("Pat Parent")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "VAL@" } });
    expect(screen.getByText("Val Volunteer")).toBeInTheDocument();
    expect(screen.queryByText("Pat Parent")).not.toBeInTheDocument();
  });

  it("leaves location out of the filter when rows carry at most one location", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/facility/badges": {
        badges: [
          { id: 1, timestamp: "2026-01-01T14:00:00.000Z", person: { name: "Val Volunteer", email: "val@example.com" }, location: "Side Door" },
          { id: 2, timestamp: "2026-01-01T15:00:00.000Z", person: { name: "Pat Parent", email: "pat@example.com" } },
        ],
      },
    });
    renderWithProviders(<AdminBadgesPage />);

    await screen.findByText("Val Volunteer");
    fireEvent.change(screen.getByPlaceholderText("Filter by name, email, or ID..."), { target: { value: "side" } });
    expect(screen.queryByText("Val Volunteer")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<AdminBadgesPage />);

    expect(await screen.findByText("Failed to load badge events.")).toBeInTheDocument();
  });
});
