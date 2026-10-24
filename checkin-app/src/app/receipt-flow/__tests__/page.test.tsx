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

const section = (name: string) => screen.findByRole("region", { name });

beforeEach(() => resetRtl());

describe("receipt flow status page", () => {
  it("shows every section with zeros for FINANCE, and when the counts were read", async () => {
    setSession({ id: 1, isFinance: true });
    mockFetchJson({ "/api/receipt-flow/status": ALL_ZERO });
    renderWithProviders(<ReceiptFlowStatusPage />);

    const receipts = await section("Receipts");
    for (const s of ALL_ZERO.receipt.states) expect(within(receipts).getByText(s.label)).toBeInTheDocument();
    expect(within(receipts).getByText("Done, not yet sent to receiving")).toBeInTheDocument();
    expect(within(receipts).getAllByText("0")).toHaveLength(4);

    const receiving = await section("Receiving");
    expect(within(receiving).getByText("Label applying")).toBeInTheDocument();
    expect(within(receiving).getAllByText("0")).toHaveLength(4);

    const expenses = await section("Expenses");
    expect(within(expenses).getAllByText("0")).toHaveLength(3);

    expect(screen.getByText(/^As of /)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows an inventory manager the receiving section alone", async () => {
    setSession({ id: 2, isInventoryManager: true });
    mockFetchJson({ "/api/receipt-flow/status": { asOf: ALL_ZERO.asOf, receiving: { states: [{ state: "applying", label: "Applying", count: 3 }] } } });
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect(within(await section("Receiving")).getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Receipts" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Expenses" })).toBeNull();
  });

  it("says a section is not set up when its library has no database", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/receipt-flow/status": { ...ALL_ZERO, expense: null } });
    renderWithProviders(<ReceiptFlowStatusPage />);

    expect(within(await section("Expenses")).getByText("Not set up here.")).toBeInTheDocument();
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
