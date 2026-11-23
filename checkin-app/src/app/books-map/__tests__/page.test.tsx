type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import { QUICKBOOKS_LIST_STALE as KIT_LIST_STALE } from "@checkin/component-ui";
import { QUICKBOOKS_LIST_STALE } from "@checkin/quickbooks/accountTypes";
import BooksMapPage from "../page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const map = {
  BooksMapClass: [{ budgetOwnerId: 7, budgetOwnerName: "Robotics", quickBooksClassId: null }],
  BooksMapAccount: [{ role: "SHOPIFY_BANK", quickBooksAccountId: null }, { role: "SHOPIFY_FEES", quickBooksAccountId: "8002" }],
};

let write: () => Promise<Response>;
let catchUp: (init?: RequestInit) => unknown;
let fetchMock: jest.Mock;

beforeEach(() => {
  resetRtl();
  jest.clearAllMocks();
  // jsdom has no scrollIntoView, which Mantine's combobox calls on open with a value picked.
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
  write = async () => jsonResponse(200, { role: "SHOPIFY_BANK", quickBooksAccountId: "8001" });
  catchUp = () => ({ lane: "expense", status: "idle", heldBy: null, until: null, queued: [], pausedUntil: null, lastRuns: {} });
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/api/finance/quickbooks/catch-up")) return jsonResponse(200, catchUp(init));
    if (init?.method) return write();
    if (url.includes("/quickbooks-classes")) return jsonResponse(200, [{ id: "9003", name: "Programs:Robotics", active: true }]);
    if (url.includes("/quickbooks-accounts")) return jsonResponse(200, [
      { id: "8001", name: "Checking", accountType: "Bank", active: true },
      { id: "8002", name: "Sales:Shop sales", accountType: "Income", active: true },
      { id: "8004", name: "Merchant fees", accountType: "Expense", active: true },
      { id: "8008", name: "Kit materials", accountType: "Cost of Goods Sold", active: true },
    ]);
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

  it("offers a role only the account types it accepts", async () => {
    setSession({ id: 1, isFinance: true });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Shopify payouts: bank account" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Checking"]);
  });

  it("keeps a saved account of the wrong type in the list, marked", async () => {
    setSession({ id: 1, isFinance: true });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Shopify: fees" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Sales:Shop sales (wrong type: Income)", "Merchant fees"]);
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
      message: "That QuickBooks Class is already mapped to another bucket.",
    })));
  });

  it("says nothing was saved when a sleeping app answers the save", async () => {
    setSession({ id: 1, isFinance: true });
    write = async () => new Response("<html>Waking up</html>", { status: 503, headers: { "Retry-After": "30" } });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Class for Robotics" }));
    fireEvent.click(await screen.findByRole("option", { name: "Programs:Robotics" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
      color: "red",
      title: "Class not saved",
      message: "The app was asleep and is starting up. Nothing was saved. Try again in a minute.",
    })));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("shows the board the map without letting it edit, and lets it update the QuickBooks lists", async () => {
    setSession({ id: 1, isBoardMember: true });
    renderWithProviders(<BooksMapPage />);
    expect(await screen.findByRole("textbox", { name: "Shopify payouts: bank account" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Class for Robotics" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
  });

  it("reloads its pickers after Update now", async () => {
    setSession({ id: 1, isFinance: true });
    renderWithProviders(<BooksMapPage />);
    await screen.findByRole("textbox", { name: "Class for Robotics" });
    const accountReads = () => fetchMock.mock.calls.filter(([url, init]) => url.toString().includes("/quickbooks-accounts") && !init?.method).length;
    expect(accountReads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(accountReads()).toBe(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/books-map/quickbooks-lists/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("asks for a lane's QuickBooks catch-up and shows the lane posting", async () => {
    setSession({ id: 1, isFinance: true });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Catch up gifts of goods" }));
    catchUp = () => ({ lane: "expense", status: "idle", heldBy: "in-kind", until: "2026-11-18T14:05:00.000Z", queued: ["income"], pausedUntil: null, lastRuns: {} });

    expect(await screen.findByRole("button", { name: "Gifts of goods: posting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Income: waiting" })).toBeDisabled();
    expect(screen.getByText("Posting Gifts of goods to QuickBooks now. Waiting: Income.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/finance/quickbooks/catch-up", expect.objectContaining({ method: "POST", body: JSON.stringify({ lane: "in-kind" }) }));
  });

  it("offers Update now beside a save refused against an out-of-date QuickBooks list", async () => {
    setSession({ id: 1, isFinance: true });
    const refusal = "QuickBooks' list in the app doesn't have an account with id 8001. If you changed it in QuickBooks, press Update now, then save again.";
    write = async () => jsonResponse(400, { error: refusal, code: "quickbooks-list-stale" });
    renderWithProviders(<BooksMapPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Shopify payouts: bank account" }));
    fireEvent.click(await screen.findByRole("option", { name: "Checking" }));

    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", title: "Account not saved" })));
    const chip = jest.mocked(notifications.show).mock.calls.find(([n]) => n.title === "Account not saved")?.[0];
    renderWithProviders(<>{chip?.message}</>);
    expect(screen.getByText(/doesn't have an account with id 8001/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Update now" })).toHaveLength(2);
  });

  it("shows a failed books map load in place of the tables", async () => {
    setSession({ id: 1, isFinance: true });
    const reply = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      input.toString() === "/api/books-map" ? jsonResponse(403, { error: "Finance only" }) : reply(input, init));
    renderWithProviders(<BooksMapPage />);

    expect(await screen.findByText("Couldn't load the books map")).toBeInTheDocument();
    expect(screen.getByText("Finance only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Class for Robotics" })).not.toBeInTheDocument();
  });

  it("shows a failed QuickBooks account list load beside the map", async () => {
    setSession({ id: 1, isFinance: true });
    const reply = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      input.toString().includes("/quickbooks-accounts") ? jsonResponse(404, { error: "No saved list" }) : reply(input, init));
    renderWithProviders(<BooksMapPage />);

    expect(await screen.findByText("Couldn't load QuickBooks accounts")).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Class for Robotics" })).toBeInTheDocument();
  });

  describe("inactive QuickBooks entries", () => {
    // The copy marks Class 9005 and account 8005 inactive; both are saved picks here.
    beforeEach(() => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (init?.method || url.includes("/quickbooks/catch-up")) return base(input, init);
        if (url.includes("/quickbooks-classes")) return jsonResponse(200, [
          { id: "9003", name: "Programs:Robotics", active: true },
          { id: "9005", name: "Retired", active: false },
        ]);
        if (url.includes("/quickbooks-accounts")) return jsonResponse(200, [
          { id: "8001", name: "Checking", accountType: "Bank", active: true },
          { id: "8005", name: "Old savings", accountType: "Bank", active: false },
        ]);
        return jsonResponse(200, {
          BooksMapClass: [{ budgetOwnerId: 7, budgetOwnerName: "Robotics", quickBooksClassId: "9005" }],
          BooksMapAccount: [{ role: "SHOPIFY_BANK", quickBooksAccountId: "8005" }],
        });
      });
    });

    it("offers no inactive Class, and warns beside the picker holding one", async () => {
      setSession({ id: 1, isFinance: true });
      renderWithProviders(<BooksMapPage />);
      const picker = await screen.findByRole("textbox", { name: "Class for Robotics" });
      const warning = (await screen.findByText("Retired is inactive in QuickBooks. Pick an active one.")).closest<HTMLElement>("[role=alert]")!;
      expect(within(warning).getByRole("button", { name: "Update now" })).toBeInTheDocument();
      expect(picker).toHaveValue("");
      fireEvent.click(picker);
      expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Programs:Robotics"]);
    });

    it("offers no inactive account, and warns beside the role holding one", async () => {
      setSession({ id: 1, isFinance: true });
      renderWithProviders(<BooksMapPage />);
      const picker = await screen.findByRole("textbox", { name: "Shopify payouts: bank account" });
      const warning = (await screen.findByText("Old savings is inactive in QuickBooks. Pick an active one.")).closest<HTMLElement>("[role=alert]")!;
      expect(within(warning).getByRole("button", { name: "Update now" })).toBeInTheDocument();
      expect(picker).toHaveValue("");
      fireEvent.click(picker);
      expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Checking"]);
    });

    it("tells the board Finance fixes an inactive pick", async () => {
      setSession({ id: 1, isBoardMember: true });
      renderWithProviders(<BooksMapPage />);
      expect(await screen.findByText("Retired is inactive in QuickBooks. Finance can fix this.")).toBeInTheDocument();
      expect(screen.getByText("Old savings is inactive in QuickBooks. Finance can fix this.")).toBeInTheDocument();
      expect(screen.queryByText(/Pick an active one/)).not.toBeInTheDocument();
    });
  });

  it("matches the client kit's stale-list code to the one saves throw", () => {
    expect(KIT_LIST_STALE).toBe(QUICKBOOKS_LIST_STALE);
  });
});
