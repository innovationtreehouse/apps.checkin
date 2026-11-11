import {
  financeViewKindOf,
  financeViewRecordHref,
  financeViewSentence,
  type FinanceViewRow,
} from "@/lib/finance/financeViewKinds";

function row(overrides: Partial<FinanceViewRow>): FinanceViewRow {
  return {
    id: 1,
    viewedAt: "2026-10-27T14:05:00.000Z",
    actorId: 12,
    role: "isFinance",
    endpoint: "GET /api/receipts",
    params: {},
    recordIds: ["r_1"],
    rowCount: 1,
    ...overrides,
  };
}

describe("financeViewKindOf", () => {
  it.each([
    ["GET /api/receipts", "receipts"],
    ["GET /api/receipts/[id]", "receipts"],
    ["GET /api/receipts/abc", "receipts"],
    ["GET /api/workflow-mapping/receipts/[id]", "receipts"],
    ["GET /api/expense/finance-queue", "expenses"],
    ["GET /api/income/payouts/[gid]", "payouts"],
    ["GET /api/donations/transactions", "donations"],
    ["GET /api/donations/uploaded-files/[id]/blob", "donations"],
    ["GET /api/donations/in-kind/manual/[id]", "giftsOfGoods"],
    ["GET /api/finance-ops/payments", "payments"],
  ])("reads %s as %s", (endpoint, kind) => {
    expect(financeViewKindOf(endpoint)?.key).toBe(kind);
  });

  it("matches whole path segments only", () => {
    expect(financeViewKindOf("GET /api/expenses-report")).toBeNull();
    expect(financeViewKindOf("GET /api/receiptsx")).toBeNull();
  });
});

describe("financeViewRecordHref", () => {
  it("links every id a receipt list returned", () => {
    expect(financeViewRecordHref(row({ recordIds: ["r_1", "r_2"] }), "r_2")).toBe("/receipts/r_2");
  });

  it("links only the record a detail endpoint names, not its lines", () => {
    const detail = row({ endpoint: "GET /api/receipts/[id]", params: { id: "r_1" }, recordIds: ["r_1", "line_9"] });
    expect(financeViewRecordHref(detail, "r_1")).toBe("/receipts/r_1");
    expect(financeViewRecordHref(detail, "line_9")).toBeNull();
  });

  it("links a copied row that holds the concrete receipt path", () => {
    expect(financeViewRecordHref(row({ endpoint: "GET /api/receipts/abc", recordIds: ["abc"] }), "abc")).toBe("/receipts/abc");
  });

  it("links a copied in-kind row with no params by its one record id", () => {
    const copied = row({ endpoint: "GET /api/donations/in-kind/manual/[id]", role: null, recordIds: ["g_4"] });
    expect(financeViewRecordHref(copied, "g_4")).toBe("/donations/in-kind/manual/g_4");
  });

  it("leaves an id with no page as plain text", () => {
    expect(financeViewRecordHref(row({ endpoint: "GET /api/donations/transactions" }), "t_1")).toBeNull();
  });
});

describe("financeViewSentence", () => {
  const at = new Date("2026-10-27T14:05:00.000Z");
  const when = `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;

  it("names the viewer, role, count, kind and place", () => {
    const r = row({ endpoint: "GET /api/expense/finance-queue", rowCount: 3, recordIds: ["a", "b", "c"] });
    expect(financeViewSentence(r, "Pat Lee")).toBe(`Pat Lee (Finance) viewed 3 expenses on the finance queue, ${when}`);
  });

  it("leaves out the parenthesis for a copied row with no role", () => {
    const r = row({ endpoint: "GET /api/receipts/abc", role: null, recordIds: ["abc"] });
    expect(financeViewSentence(r, "Pat Lee")).toBe(`Pat Lee viewed 1 receipt on the record's page, ${when}`);
  });

  it("falls back to the person id when no name resolved", () => {
    expect(financeViewSentence(row({}), undefined)).toMatch(/^Person #12 \(Finance\) viewed 1 receipt on the receipts list/);
  });
});
