// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import UnconfirmedShopifyStockPage from "../page";

const LIST = "/api/finance-ops/shopify-stock";
const row = { programId: 7, programName: "Robotics", unconfirmed: 2, carry: 0, unconfirmedSince: null, shopifyAvailable: 5 };

const reads = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls.filter(([url, init]) => url.toString().endsWith(LIST) && (init?.method ?? "GET") === "GET");

beforeEach(() => {
  resetRtl();
  setSession({ id: 1, isBoardMember: true });
});

describe("finance-ops/shopify-stock page", () => {
  it("reads the list once on mount", async () => {
    const fetchMock = mockFetchJson({ [LIST]: [row] });
    renderWithProviders(<UnconfirmedShopifyStockPage />);

    expect(await screen.findByText("Robotics")).toBeInTheDocument();
    expect(reads(fetchMock)).toHaveLength(1);
  });

  it("shows a failed load in place of the table, not an empty list", async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "Shopify is down" }), text: async () => JSON.stringify({ error: "Shopify is down" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<UnconfirmedShopifyStockPage />);

    expect(await screen.findByText(/Shopify is down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry|try again/i })).toBeInTheDocument();
    expect(screen.queryByText("No unconfirmed Shopify stock changes.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles a row with one POST and re-reads the list once", async () => {
    const fetchMock = mockFetchJson({ [`${LIST}/7`]: { ok: true }, [LIST]: [row] });
    renderWithProviders(<UnconfirmedShopifyStockPage />);
    await screen.findByText("Robotics");

    fireEvent.click(screen.getByRole("button", { name: "Shopify has it" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(reads(fetchMock)).toHaveLength(2));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(`${LIST}/7`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ choice: "landed", expected: 2, since: null });
  });
});
