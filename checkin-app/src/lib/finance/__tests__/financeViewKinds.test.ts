/**
 * @jest-environment node
 */
import "@/security/registry";
import { allFileRoutes, allRoutes, marks, modelRelations, OUTSIDE_RECORD_NAMES } from "@/security/core";
import {
  FINANCE_VIEW_MODELS,
  financeViewCursor,
  financeViewPlace,
  financeViewRecordHref,
  financeViewRecords,
  financeViewViewer,
  parseFinanceViewCursor,
  parseRecordRef,
  recordSearchRefs,
  type FinanceViewRow,
} from "@/lib/finance/financeViewKinds";

function row(overrides: Partial<FinanceViewRow>): FinanceViewRow {
  return {
    id: 1,
    viewedAt: "2026-11-06T14:05:00.000Z",
    actorId: 12,
    role: "isFinance",
    endpoint: null,
    recordIds: ["Expense:e_123"],
    pagePath: "/expense/expenses/e_123",
    calls: [{ endpoint: "GET /api/expense/expenses/[id]", path: "/api/expense/expenses/e_123", query: {}, role: "isFinance" }],
    records: [{ ref: "Expense:e_123", fields: ["receiptTotalCents", "submitterId"] }],
    ...overrides,
  };
}

describe("financeViewRecordHref", () => {
  it.each([
    ["Expense:e_123", "/expense/expenses/e_123"],
    ["Receipt:r_9", "/receipts/r_9"],
    ["InKindDonation:5", "/donations/in-kind/receipt/5"],
    ["ManualInKindDonation:5", "/donations/in-kind/manual/5"],
    ["Receipt:a/b", "/receipts/a%2Fb"],
  ])("links %s to %s", (ref, href) => {
    expect(financeViewRecordHref(ref)).toBe(href);
  });

  it.each([
    ["a record kept in QuickBooks", "QuickBooks.Transaction:4412"],
    ["a Benevity disbursement", "Benevity.Disbursement:BEN-889"],
    ["a model with no page of its own", "ShopPayout:gid://shopify/Payout/1"],
    ["a record named by two ids", "ProgramParticipant:12:345"],
    ["marked fields no record could take", "unnamed:FinanceQueueRow"],
    ["a value the model map does not know", "unknown-source:paypal:5"],
    ["an older row's bare id", "e_123"],
  ])("leaves %s as plain text", (_label, ref) => {
    expect(financeViewRecordHref(ref)).toBeNull();
  });
});

describe("parseRecordRef", () => {
  it("splits at the first colon, so a composite id stays whole", () => {
    expect(parseRecordRef("ProgramParticipant:12:345")).toEqual({ model: "ProgramParticipant", id: "12:345" });
    expect(parseRecordRef("QuickBooks.Transaction:4412")).toEqual({ model: "QuickBooks.Transaction", id: "4412" });
  });

  it("names no model for an unknown prefix, a bare id or an empty id", () => {
    expect(parseRecordRef("unnamed:FinanceQueueRow")).toBeNull();
    expect(parseRecordRef("r_1")).toBeNull();
    expect(parseRecordRef("Expense:")).toBeNull();
  });
});

describe("recordSearchRefs", () => {
  it("searches a bare id as itself and under every model", () => {
    const refs = recordSearchRefs("e_123");
    expect(refs).toContain("e_123");
    expect(refs).toContain("Expense:e_123");
    expect(refs).toContain("QuickBooks.Transaction:e_123");
    expect(refs).toHaveLength(FINANCE_VIEW_MODELS.length + 1);
  });

  it("searches a ref as the ref, its bare id, and that id under every model", () => {
    const refs = recordSearchRefs("Expense:e_123");
    expect(refs).toContain("e_123");
    expect(refs).toContain("Receipt:e_123");
    expect(refs).toHaveLength(FINANCE_VIEW_MODELS.length + 1);
  });

  it("keeps a composite id whole, and searches an unknown prefix as typed", () => {
    expect(recordSearchRefs("12:345")).toContain("ProgramParticipant:12:345");
    expect(recordSearchRefs("unnamed:FinanceQueueRow")).toContain("unnamed:FinanceQueueRow");
  });
});

describe("FINANCE_VIEW_MODELS", () => {
  // Every model a log row can name: each declared model, each outside name, each file route's
  // model, and each marked top-level model a GET route names by its own id.
  function nameableModels(): Set<string> {
    const out = new Set<string>(OUTSIDE_RECORD_NAMES);
    for (const [endpoint, route] of allRoutes()) {
      if (!endpoint.startsWith("GET ")) continue;
      const declaredKeys = new Set<string>();
      for (const record of route.financeView?.records ?? []) {
        declaredKeys.add(record.key);
        if (typeof record.model === "string") out.add(record.model);
        else Object.values(record.model.map).forEach((m) => out.add(m));
      }
      const returns: readonly string[] = route.returns ?? [];
      const nested = new Set(returns.flatMap((m) => Object.values(modelRelations(m)).map((rel) => rel.model)));
      for (const model of returns) {
        if (!declaredKeys.has(model) && !nested.has(model) && (marks[model] ?? []).length > 0) out.add(model);
      }
    }
    for (const [, fileRoute] of allFileRoutes()) out.add(fileRoute.file.model);
    return out;
  }

  it("lists every model a log row can name, and nothing else", () => {
    expect([...FINANCE_VIEW_MODELS].sort()).toEqual([...nameableModels()].sort());
  });
});

describe("financeViewRecords", () => {
  it("reads each record with its marked field names", () => {
    expect(financeViewRecords(row({}))).toEqual([{ ref: "Expense:e_123", fields: ["receiptTotalCents", "submitterId"] }]);
  });

  it("reads an older row's bare ids with no field names", () => {
    expect(financeViewRecords(row({ records: null, recordIds: ["r_1", "r_2"] }))).toEqual([
      { ref: "r_1", fields: [] },
      { ref: "r_2", fields: [] },
    ]);
  });
});

describe("financeViewPlace", () => {
  it("names the page of a page-view row", () => {
    expect(financeViewPlace(row({}))).toBe("on /expense/expenses/e_123");
  });

  it("names the API path and declared query of an untagged row", () => {
    const calls = [{ endpoint: "GET /api/expense/finance-queue", path: "/api/expense/finance-queue", query: { tab: "holds" }, role: "isFinance" }];
    expect(financeViewPlace(row({ pagePath: null, calls }))).toBe("via GET /api/expense/finance-queue?tab=holds");
  });

  it("names an older row's registry key", () => {
    expect(financeViewPlace(row({ pagePath: null, calls: null, endpoint: "GET /api/receipts" }))).toBe("via GET /api/receipts");
  });
});

describe("financeViewViewer", () => {
  it("names the viewer and the role the view was chosen under", () => {
    expect(financeViewViewer(row({}), "Pat Lee")).toBe("Pat Lee (Finance)");
    expect(financeViewViewer(row({ role: null }), undefined)).toBe("Person #12");
  });
});

describe("the before marker", () => {
  it("round-trips a row's viewedAt and id", () => {
    const marker = financeViewCursor(row({ id: 41 }));
    expect(marker).toBe(`${Date.parse("2026-11-06T14:05:00.000Z")}_41`);
    expect(parseFinanceViewCursor(marker)).toEqual({ viewedAt: new Date("2026-11-06T14:05:00.000Z"), id: 41 });
  });

  it.each(["", "41", "2026-11-06_41", "1762437900000_0", "1762437900000_-1", "1762437900000_2147483648", "1_2_3"])(
    "refuses %j",
    (value) => {
      expect(parseFinanceViewCursor(value)).toBeNull();
    },
  );
});
