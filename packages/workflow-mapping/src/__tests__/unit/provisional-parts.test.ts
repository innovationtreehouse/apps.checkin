/** The associate picker's provisional parts: the org's pending and local-only parts from the catalog port, as gtin13, name and status alone. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogReader } from "../../contract";
import { inertCatalogReader, inertCatalogSubmissions } from "../../contract";
import { configure } from "../helpers/setup";

vi.mock("../../db", () => ({ db: {} }));

const { provisionalParts } = await import("../../routes");

const searchOrgProvisionalItems = vi.fn<CatalogReader["searchOrgProvisionalItems"]>();
const catalogReader: CatalogReader = { ...inertCatalogReader, searchOrgProvisionalItems };

const part = (n: number, status = "pending") => ({ gtin13: `02000027${String(n).padStart(5, "0")}`, name: `Part ${n}`, status });

async function call(q: string | null) {
  const url = new URL("http://localhost/api/workflow-mapping/provisional-parts");
  if (q !== null) url.searchParams.set("q", q);
  return provisionalParts({ req: new Request(url), params: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  configure({ catalogReader, catalogSubmissions: inertCatalogSubmissions });
});

describe("provisional parts route", () => {
  it("passes the trimmed query to the org-scoped catalog search", async () => {
    searchOrgProvisionalItems.mockResolvedValue([part(1), part(2, "rejected")]);
    expect(await call("  shelf ")).toEqual({ WorkflowProvisionalPart: [part(1), part(2, "rejected")] });
    expect(searchOrgProvisionalItems).toHaveBeenCalledWith("shelf");
  });

  it.each([["absent", null], ["blank", "   "]])("lists none for an %s query without asking the catalog", async (_case, q) => {
    expect(await call(q)).toEqual({ WorkflowProvisionalPart: [] });
    expect(searchOrgProvisionalItems).not.toHaveBeenCalled();
  });

  it("returns gtin13, name and status alone, at most 20", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ ...part(i), rejectionReason: "Duplicate", orgId: "org" }));
    searchOrgProvisionalItems.mockResolvedValue(rows);
    const { WorkflowProvisionalPart } = await call("part");
    expect(WorkflowProvisionalPart).toEqual(Array.from({ length: 20 }, (_, i) => part(i)));
  });

  it("answers 502 when the catalog can't be reached", async () => {
    searchOrgProvisionalItems.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(call("shelf")).rejects.toMatchObject({ status: 502, message: "The catalog couldn't be reached; try again" });
  });
});
