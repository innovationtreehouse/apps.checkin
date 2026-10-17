// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import BoardContactInfoPage from "../page";

beforeEach(() => resetRtl());

describe("safety/board-contacts page", () => {
  it("loads and renders the board member directory", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({
      "/api/safety/board-contacts": {
        members: [{ id: 1, name: "Bob Board", phone: "5551234567", email: "bob@example.com" }],
      },
    });
    renderWithProviders(<BoardContactInfoPage />);

    expect(await screen.findByText("Bob Board")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("555-123-4567")).toBeInTheDocument();
  });

  it("shows the empty state with no members", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/safety/board-contacts": { members: [] } });
    renderWithProviders(<BoardContactInfoPage />);

    expect(await screen.findByText("No board members found.")).toBeInTheDocument();
  });

  it("toasts a network-error notification when the fetch rejects", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    setSession({ id: 1, isBoardMember: true });
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    renderWithProviders(<BoardContactInfoPage />);

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error loading board contacts." }),
      ),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to load"), expect.anything());
    spy.mockRestore();
  });
});
