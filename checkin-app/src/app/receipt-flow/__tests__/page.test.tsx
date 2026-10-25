type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen, within } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import ReceiptFlowStatusPage from "../page";

const zeros = (...states: string[]) => states.map((state) => ({ state, label: `Label ${state}`, count: 0 }));

const ALL_ZERO = {
  asOf: "2026-10-23T12:00:00.000Z",
  receipt: { states: zeros("uploaded", "financial_review", "receipt_finalized"), notDelivered: 0 },
  receiving: { states: zeros("pending_review", "applying", "apply_failed", "resolved") },
  expense: { states: zeros("pending", "qb_pending", "qb_complete") },
};

/** Each body row of the table as [section, state, count]. */
const rows = async () => {
  const table = await screen.findByRole("table", { name: "Records in each state" });
  return within(table).getAllByRole("row").slice(1)
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
};

beforeEach(() => resetRtl());

describe("receipt flow status page", () => {
  it("lists every state in flow order for FINANCE, and when the counts were read", async () => {
    setSession({ id: 1, isFinance: true });
    mockFetchJson({ "/api/receipt-flow/status": ALL_ZERO });
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect(await rows()).toEqual([
      ...ALL_ZERO.receipt.states.map((s) => ["Receipts", s.label, "0"]),
      ["Receipts", "Receipt finalized, not yet sent to part mapping", "0"],
      ...ALL_ZERO.receiving.states.map((s) => ["Part mapping", s.label, "0"]),
      ...ALL_ZERO.expense.states.map((s) => ["Expenses", s.label, "0"]),
    ]);
    expect(screen.getByText(/^As of /)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows an inventory manager the Part mapping rows alone", async () => {
    setSession({ id: 2, isInventoryManager: true });
    mockFetchJson({ "/api/receipt-flow/status": { asOf: ALL_ZERO.asOf, receiving: { states: [{ state: "applying", label: "Applying", count: 3 }] } } });
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect(await rows()).toEqual([["Part mapping", "Applying", "3"]]);
  });

  it("says a section is not set up when its library has no database", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/receipt-flow/status": { ...ALL_ZERO, expense: null } });
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect((await rows()).at(-1)).toEqual(["Expenses", "Not set up here.", ""]);
  });

  it("shows why the counts failed to load", async () => {
    setSession({ id: 1, isFinance: true });
    mockFetchJson({});
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect(await screen.findByText("Couldn't load the counts (error 404).")).toBeInTheDocument();
  });

  it("sends anyone else away", () => {
    setSession({ id: 3, isSysadmin: true });
    mockFetchJson({ "/api/receipt-flow/status": ALL_ZERO });
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect(router.push).toHaveBeenCalledWith("/");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
