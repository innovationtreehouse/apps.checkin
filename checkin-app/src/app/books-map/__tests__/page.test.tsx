type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), hide: jest.fn() } }));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import BooksMapPage from "../page";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const map = {
  BooksMapClass: [{ budgetOwnerId: 7, budgetOwnerName: "Robotics", quickBooksClassId: null }],
  BooksMapAccount: [{ role: "SHOPIFY_BANK", quickBooksAccountId: null }],
};

let write: () => Promise<Response>;
let fetchMock: jest.Mock;

beforeEach(() => {
  resetRtl();
  jest.clearAllMocks();
  write = async () => jsonResponse(200, { role: "SHOPIFY_BANK", quickBooksAccountId: "8001" });
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method) return write();
    if (url.includes("/quickbooks-classes")) return jsonResponse(200, [{ id: "9003", name: "Programs:Robotics", active: true }]);
    if (url.includes("/quickbooks-accounts")) return jsonResponse(200, [{ id: "8001", name: "Checking", accountType: "Bank", active: true }]);
    return jsonResponse(200, map);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("books map page", () => {
  it("lets finance set a role's account", async () => {
    setSession({ id: 1, isFinance: true });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Shopify payouts: bank account" }));
    fireEvent.click(await screen.findByRole("option", { name: "Checking" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/books-map/accounts/SHOPIFY_BANK", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ quickBooksAccountId: "8001" }),
    })));
  });

  it("shows a refused save in a red chip", async () => {
    setSession({ id: 1, isFinance: true });
    write = async () => jsonResponse(409, { error: "That QuickBooks Class is already mapped to another bucket." });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Class for Robotics" }));
    fireEvent.click(await screen.findByRole("option", { name: "Programs:Robotics" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Class not saved",
      message: "That QuickBooks Class is already mapped to another bucket. (409)",
    })));
  });

  it("shows the board the map without letting it edit", async () => {
    setSession({ id: 1, isBoardMember: true });
    renderWithProviders(<BooksMapPage />);
    expect(await screen.findByRole("textbox", { name: "Shopify payouts: bank account" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Class for Robotics" })).toBeDisabled();
  });
});
