import { HttpError } from "@checkin/component-ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptPage from "@checkin/workflow-mapping/pages/receipt";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useParams: () => ({ id: "7" }), useRouter: () => ({ push: mockPush }) }));
const mockShow = jest.fn();
const mockApi = jest.fn();

jest.mock("@mantine/notifications", () => ({ notifications: { show: (...args: unknown[]) => mockShow(...args) } }));
let mockIsManager = true;
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1, isInventoryManager: mockIsManager } } }) }));

const receipt = {
  id: 7, state: "pending_review", validationNotes: null, createdAt: "2026-10-02T15:30:00Z",
  inventoryAppliedAt: null, expenseAppliedAt: null, donationAppliedAt: null, matchingPendingSince: null as string | null,
  applyFirstFailedAt: null as string | null,
};
const baseDetail = {
  ReceivedReceipt: receipt,
  WorkflowReceiptView: {
    receiptId: "rcpt-abc-123", vendorName: "Acme Supply", currency: "USD", receiptDate: "2026-10-01",
    receiptTotalCents: 5432, taxCents: 321, shippingCents: 899, discountCents: 250,
    lineItems: [
      { receiptLineItemId: 1, lineNumber: 1, description: "Wood glue", partNumber: "WG-8", manufacturer: "Titebond", quantity: 3, unitPriceCents: 650, totalPriceCents: 1950 },
      { receiptLineItemId: 2, lineNumber: 2, description: "Gift card", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 2500, totalPriceCents: 2500 },
    ],
  },
  ReceivedReceiptLineStatus: [
    { id: 11, receiptLineItemId: 1, recognitionStatus: "unrecognized", assignedGtin13: null as string | null, provisionalItemGtin13: null, conversionFactor: 1 },
    { id: 12, receiptLineItemId: 2, recognitionStatus: "non_inventory", assignedGtin13: null, provisionalItemGtin13: null, conversionFactor: 1 },
  ],
};
let detail = baseDetail;

jest.mock("@checkin/workflow-mapping/components/api", () => ({
  ...jest.requireActual("@checkin/workflow-mapping/components/api"),
  api: (...args: unknown[]) => mockApi(...args),
  useLoad: (path: string) => ({ data: path === "/receipts/7" ? detail : [], error: null, reload: jest.fn() }),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  jest.clearAllMocks();
  detail = baseDetail;
  mockIsManager = true;
});

const wrap = () => render(<MantineProvider><ReceiptPage /></MantineProvider>);

const BANNER = "Item names couldn't be loaded from the catalog. Showing part numbers.";

/** The Mapping cell of the line whose row matches `name`. */
const mappingCell = (name: RegExp) => within(screen.getByRole("row", { name })).getAllByRole("cell")[6];

/** The value printed under a header field's label; the selector skips the table's same-named column header. */
const field = (label: string) => screen.getByText(label, { selector: "p" }).nextElementSibling?.textContent;

describe("the receiving page's Mapping column", () => {
  const mapped = (fields: { assignedGtin13?: string; provisionalItemGtin13?: string; proposedName?: string }) => {
    detail = {
      ...baseDetail,
      ReceivedReceiptLineStatus: [{ ...baseDetail.ReceivedReceiptLineStatus[0], assignedGtin13: null, provisionalItemGtin13: null, ...fields, conversionFactor: 2 }] as typeof baseDetail.ReceivedReceiptLineStatus,
    };
  };

  /** Answers the catalog and org-items reads; a GTIN missing from a map is a 404. */
  const serve = (catalog: Record<string, string>, provisionals: Record<string, string>) =>
    mockApi.mockImplementation(async (path: string) => {
      const gtin13 = path.split("/").pop() ?? "";
      if (path.startsWith("/api/catalog/items/") && catalog[gtin13]) return { gtin13, name: catalog[gtin13] };
      if (path.startsWith("/api/inventory/org-items/") && provisionals[gtin13]) {
        return { OrgItem: { gtin13 }, InventoryProvisionalItem: [{ provisionalGtin13: gtin13, name: provisionals[gtin13] }] };
      }
      throw new HttpError("Not found", 404);
    });

  it("shows a provisional part by its short ID and the line's name before it has a provisional row", async () => {
    serve({}, {});
    mapped({ provisionalItemGtin13: "0200002701237" });
    wrap();
    await act(async () => {});
    expect(mappingCell(/Wood glue/)).toHaveTextContent("P000123 · Wood glue ×2");
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("shows a proposed provisional part by its proposed name before it has a provisional row", async () => {
    serve({}, {});
    mapped({ provisionalItemGtin13: "0200002701237", proposedName: "Titebond II glue" });
    wrap();
    await act(async () => {});
    expect(mappingCell(/Wood glue/)).toHaveTextContent("P000123 · Titebond II glue ×2");
  });

  it("shows a provisional part by its provisional name", async () => {
    serve({}, { "0200002701237": "Titebond II glue" });
    mapped({ provisionalItemGtin13: "0200002701237" });
    wrap();
    expect(await within(screen.getByRole("row", { name: /Wood glue/ })).findByText("P000123 · Titebond II glue ×2")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/api/inventory/org-items/0200002701237");
  });

  it("names an assigned part the catalog lacks by its provisional name", async () => {
    serve({}, { "0200002701237": "Titebond II glue" });
    mapped({ assignedGtin13: "0200002701237" });
    wrap();
    expect(await within(screen.getByRole("row", { name: /Wood glue/ })).findByText("P000123 · Titebond II glue ×2")).toBeInTheDocument();
  });

  it("does not read org-items for a part the catalog names", async () => {
    serve({ "0200030200429": "Titebond III" }, {});
    mapped({ assignedGtin13: "0200030200429" });
    wrap();
    expect(await within(screen.getByRole("row", { name: /Wood glue/ })).findByText("03B0042 · Titebond III ×2")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("shows a catalog part by its short ID and catalog name", async () => {
    mockApi.mockResolvedValue({ gtin13: "0200030200429", name: "Titebond III" });
    mapped({ assignedGtin13: "0200030200429" });
    wrap();
    expect(await within(screen.getByRole("row", { name: /Wood glue/ })).findByText("03B0042 · Titebond III ×2")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/api/catalog/items/0200030200429");
  });

  it("says Name unavailable and shows the banner when the catalog read fails", async () => {
    mockApi.mockRejectedValue(new HttpError("Server error", 500));
    mapped({ assignedGtin13: "4006381333931" });
    wrap();
    expect(mappingCell(/Wood glue/)).toHaveTextContent("4006381333931 ×2");
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(mappingCell(/Wood glue/)).toHaveTextContent("4006381333931 · Name unavailable ×2");
  });

  it("says Not in catalog for an assigned part neither the catalog nor org-items names, with no banner", async () => {
    serve({}, {});
    mapped({ assignedGtin13: "4006381333931" });
    wrap();
    expect(await within(screen.getByRole("row", { name: /Wood glue/ })).findByText("4006381333931 · Not in catalog ×2")).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("says Name unavailable and shows the banner when the org-items read fails", async () => {
    mockApi.mockImplementation(async (path: string) => {
      throw path.startsWith("/api/inventory/org-items/") ? new HttpError("Server error", 500) : new HttpError("Not found", 404);
    });
    mapped({ assignedGtin13: "4006381333931" });
    wrap();
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(mappingCell(/Wood glue/)).toHaveTextContent("4006381333931 · Name unavailable ×2");
  });

  it("names a provisional part by its provisional name even when the catalog read fails", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/inventory/org-items/")) {
        return { InventoryProvisionalItem: [{ provisionalGtin13: "0200002701237", name: "Titebond II glue" }] };
      }
      throw new HttpError("Server error", 500);
    });
    mapped({ assignedGtin13: "0200002701237" });
    wrap();
    expect(await within(screen.getByRole("row", { name: /Wood glue/ })).findByText("P000123 · Titebond II glue ×2")).toBeInTheDocument();
  });
});

describe("the receiving page for one receipt", () => {
  it("shows the receipt's money and identity in the header", () => {
    wrap();
    expect(field("Total")).toBe("$54.32");
    expect(field("Tax")).toBe("$3.21");
    expect(field("Shipping")).toBe("$8.99");
    expect(field("Discount")).toBe("-$2.50");
    expect(field("Receipt id")).toBe("rcpt-abc-123");
    expect(field("Received")).toBe(new Date("2026-10-02T15:30:00Z").toLocaleString());
  });

  it("shows a negative discount as an amount added, with one sign", () => {
    detail = { ...detail, WorkflowReceiptView: { ...detail.WorkflowReceiptView, discountCents: -250 } };
    wrap();
    expect(field("Discount")).toBe("$2.50");
  });

  it("shows each line's unit price and line total", () => {
    wrap();
    const row = screen.getByRole("row", { name: /Wood glue/ });
    expect(within(row).getByText("$6.50")).toBeInTheDocument();
    expect(within(row).getByText("$19.50")).toBeInTheDocument();
  });

  it("labels line statuses in plain words", () => {
    wrap();
    expect(mappingCell(/Wood glue/)).toHaveTextContent("Unrecognized");
    expect(mappingCell(/Gift card/)).toHaveTextContent("Not inventory");
    expect(screen.queryByText("non inventory")).not.toBeInTheDocument();
  });

  describe("a line's actions", () => {
    const actions = (name: RegExp) => within(screen.getByRole("row", { name })).queryAllByRole("button").map((b) => b.textContent);

    it("offers Associate and Not inventory on an undecided line", () => {
      wrap();
      expect(actions(/Wood glue/)).toEqual(["Associate", "Not inventory"]);
    });

    it.each(["recognized", "provisional", "non_inventory"])("offers only Change on a %s line", (recognitionStatus) => {
      detail = {
        ...baseDetail,
        ReceivedReceiptLineStatus: [{ ...baseDetail.ReceivedReceiptLineStatus[0], recognitionStatus }, baseDetail.ReceivedReceiptLineStatus[1]],
      };
      wrap();
      expect(actions(/Wood glue/)).toEqual(["Change"]);
    });

    it("opens the line's mapping form from Change", () => {
      wrap();
      fireEvent.click(within(screen.getByRole("row", { name: /Gift card/ })).getByRole("button", { name: "Change" }));
      const panel = screen.getByRole("region", { name: "Line 2 details" });
      expect(within(panel).getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    it("marks a linked line not inventory from its open form", async () => {
      detail = {
        ...baseDetail,
        ReceivedReceiptLineStatus: [{ ...baseDetail.ReceivedReceiptLineStatus[0], recognitionStatus: "recognized" }, baseDetail.ReceivedReceiptLineStatus[1]],
      };
      mockApi.mockResolvedValue(null);
      wrap();
      fireEvent.click(within(screen.getByRole("row", { name: /Wood glue/ })).getByRole("button", { name: "Change" }));
      fireEvent.click(within(screen.getByRole("region", { name: "Line 1 details" })).getByRole("button", { name: "Not inventory" }));
      await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/receipts/7/lines/11/non-inventory", expect.anything()));
    });

    it("offers no Not inventory in the form of a line already not inventory", () => {
      wrap();
      fireEvent.click(within(screen.getByRole("row", { name: /Gift card/ })).getByRole("button", { name: "Change" }));
      expect(within(screen.getByRole("region", { name: "Line 2 details" })).queryByRole("button", { name: "Not inventory" })).not.toBeInTheDocument();
    });
  });

  it("shows an opened line's details beside its mapping form", () => {
    wrap();
    const row = screen.getByRole("row", { name: /Wood glue/ });
    fireEvent.click(within(row).getByRole("button", { name: "Associate" }));
    const panel = screen.getByRole("region", { name: "Line 1 details" });
    expect(within(panel).getByText("Line 1: Wood glue")).toBeInTheDocument();
    expect(within(panel).getByText("WG-8")).toBeInTheDocument();
    expect(within(panel).getByText("Titebond")).toBeInTheDocument();
    expect(within(panel).getByText("Unit price").nextElementSibling).toHaveTextContent("$6.50");
    expect(within(panel).getByText("Line total").nextElementSibling).toHaveTextContent("$19.50");
    expect(within(panel).getByRole("button", { name: "Save" })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Line 1 details" })).not.toBeInTheDocument();
  });

  describe("proposing from the associate search", () => {
    const hub = { gtin13: "0022222222220", name: "Power Hub", category: { name: "Electronics" }, subcategory: { name: "Control" } };
    const SEARCH = "Search the catalog by name, GTIN or category";

    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    /**
     * Opens the Wood glue line's associate panel and searches. The shared catalog search fetches
     * directly, so `results` (or an `HttpError`'s status and message) answers through `fetch`.
     */
    function search(term: string, results: unknown) {
      mockApi.mockResolvedValue(null);
      const [status, body] = results instanceof HttpError ? [results.status, { error: results.message }] : [200, results];
      global.fetch = jest.fn(async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;
      fireEvent.click(within(screen.getByRole("row", { name: /Wood glue/ })).getByRole("button", { name: "Associate" }));
      fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value: term } });
    }

    it("leaves propose off the line row and offers it before a search answers and after", async () => {
      wrap();
      expect(screen.queryByRole("button", { name: "Propose" })).not.toBeInTheDocument();
      search("wood glue", []);
      expect(screen.getByRole("button", { name: "Propose new item" })).toBeInTheDocument();
      expect(await screen.findByText("No matching catalog items")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Propose new item" })).toBeInTheDocument();
    });

    it("proposes with no search typed, leaving the name to the manager", () => {
      wrap();
      mockApi.mockResolvedValue(null);
      fireEvent.click(within(screen.getByRole("row", { name: /Wood glue/ })).getByRole("button", { name: "Associate" }));
      expect(screen.getByPlaceholderText(SEARCH)).toHaveValue("");
      fireEvent.click(screen.getByRole("button", { name: "Propose new item" }));
      const proposedName = screen.getByPlaceholderText("Proposed name");
      expect(proposedName).toHaveValue("");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      fireEvent.change(proposedName, { target: { value: "Hide glue" } });
      expect(proposedName).toHaveValue("Hide glue");
    });

    it("offers propose for a search shorter than the minimum", () => {
      wrap();
      search("w", []);
      expect(screen.getByText(/Type at least/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Propose new item" })).toBeInTheDocument();
    });

    it("offers propose below near-miss results", async () => {
      wrap();
      search("power", [hub]);
      const radio = await screen.findByRole("radio", { name: /Power Hub/ });
      const button = screen.getByRole("button", { name: "Propose new item" });
      expect(radio.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("still offers propose when the search failed", async () => {
      wrap();
      search("wood glue", new HttpError("Catalog is down", 500));
      expect(await screen.findByText("Couldn't search the catalog: Catalog is down")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Propose new item" })).toBeInTheDocument();
    });

    it("pre-fills the proposed name from the search and keeps the search when cancelled", async () => {
      wrap();
      search(" wood glue ", []);
      fireEvent.click(await screen.findByRole("button", { name: "Propose new item" }));
      expect(screen.getByPlaceholderText("Proposed name")).toHaveValue("wood glue");
      expect(screen.getByText("Line 1: Wood glue")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByPlaceholderText(SEARCH)).toHaveValue(" wood glue ");
      expect(screen.getByRole("region", { name: "Line 1 details" })).toBeInTheDocument();
    });

    it("associates a chosen result through the associate route", async () => {
      wrap();
      search("power", [hub]);
      fireEvent.click(await screen.findByRole("radio", { name: /Power Hub/ }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/receipts/7/lines/11/associate", expect.objectContaining({
        body: JSON.stringify({ gtin13: hub.gtin13, conversionFactor: 1 }),
      })));
    });
  });

  it("goes back to the receipt from an open line, then to where the receipt was opened from", () => {
    render(<MantineProvider><ReceiptPage backHref="/inventory/receiving?queue=mapping" /></MantineProvider>);
    expect(screen.getByRole("link", { name: "← Back" })).toHaveAttribute("href", "/inventory/receiving?queue=mapping");

    fireEvent.click(within(screen.getByRole("row", { name: /Wood glue/ })).getByRole("button", { name: "Associate" }));
    expect(screen.queryByRole("link", { name: "← Back" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Back to receipt" }));

    expect(screen.queryByRole("region", { name: "Line 1 details" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Back" })).toHaveAttribute("href", "/inventory/receiving?queue=mapping");
  });

  describe("a line decision that completes the receipt", () => {
    const QUEUE = "/inventory/receiving?queue=mapping";
    /** Answers the decision's POST, and the re-read of the receipt with it in `state`. */
    function afterDecision(state: string) {
      mockApi.mockImplementation(async (path: string) =>
        path === "/receipts/7" ? { ...baseDetail, ReceivedReceipt: { ...receipt, state } } : {});
    }
    const decide = () => {
      render(<MantineProvider><ReceiptPage backHref={QUEUE} /></MantineProvider>);
      fireEvent.click(within(screen.getByRole("row", { name: /Wood glue/ })).getByRole("button", { name: "Not inventory" }));
    };

    it("returns to the queue it came from once the receipt is resolved", async () => {
      afterDecision("resolved");
      decide();
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith(QUEUE));
      expect(mockShow).toHaveBeenCalledWith({ message: "Receipt resolved", color: "green" });
      expect(mockApi).toHaveBeenCalledWith("/receipts/7/lines/11/non-inventory", { method: "POST" });
    });

    it("stays on the receipt when the save leaves it needing mapping", async () => {
      afterDecision("pending_review");
      decide();
      await waitFor(() => expect(mockShow).toHaveBeenCalledWith({ message: "Marked not inventory", color: "green" }));
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("stays on the receipt when the apply failed", async () => {
      afterDecision("apply_failed");
      decide();
      await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/receipts/7"));
      await act(async () => {});
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockShow).not.toHaveBeenCalledWith({ message: "Receipt resolved", color: "green" });
    });

    it("stays on the receipt when the decision itself reports an apply failure", async () => {
      mockApi.mockResolvedValue({ state: "apply_failed", validationNotes: "Expense: QuickBooks timed out" });
      decide();
      await waitFor(() => expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ title: "Apply failed", color: "red" })));
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("returns to the queue when Run matching now resolves the receipt", async () => {
      detail = { ...baseDetail, ReceivedReceipt: { ...receipt, matchingPendingSince: "2026-10-02T15:30:00Z" } };
      afterDecision("resolved");
      render(<MantineProvider><ReceiptPage backHref={QUEUE} /></MantineProvider>);
      fireEvent.click(screen.getByRole("button", { name: "Run matching now" }));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith(QUEUE));
      expect(mockShow).toHaveBeenCalledWith({ message: "Receipt resolved", color: "green" });
    });
  });

  it("keeps an apply failure open as a red notification naming the leg and the reason", async () => {
    detail = { ...detail, ReceivedReceipt: { ...receipt, state: "apply_failed" } };
    mockApi.mockResolvedValueOnce({ id: 7, state: "applying" }).mockResolvedValueOnce({ id: 7, state: "apply_failed", validationNotes: "Expense: QuickBooks timed out" });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
    await waitFor(() =>
      expect(mockShow).toHaveBeenCalledWith({ title: "Apply failed", message: "Expense: QuickBooks timed out", color: "red", autoClose: false }),
    );
  });

  it("titles an apply that left the receipt applying as unfinished", async () => {
    detail = { ...detail, ReceivedReceipt: { ...receipt, state: "apply_failed" } };
    mockApi.mockResolvedValueOnce({ id: 7, state: "applying" }).mockResolvedValueOnce({ id: 7, state: "applying", validationNotes: "Inventory: stamp write failed" });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
    await waitFor(() =>
      expect(mockShow).toHaveBeenCalledWith({ title: "Apply didn't finish", message: "Inventory: stamp write failed", color: "red", autoClose: false }),
    );
  });

  it("offers no apply or retry while the system is applying the receipt", () => {
    detail = { ...detail, ReceivedReceipt: { ...receipt, state: "applying" } };
    wrap();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry apply" })).not.toBeInTheDocument();
    expect(screen.getByText("Applying — the system retries this automatically.")).toBeInTheDocument();
  });

  it("offers Retry apply for a receipt left applying with a recorded failure, and no automatic retry", async () => {
    detail = { ...detail, ReceivedReceipt: { ...receipt, state: "applying", applyFirstFailedAt: "2026-11-08T10:00:00Z" } };
    mockApi.mockResolvedValueOnce({ id: 7, state: "applying" }).mockResolvedValueOnce({ id: 7, state: "resolved" });
    wrap();
    expect(screen.queryByText("Applying — the system retries this automatically.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/receipts/7/apply", expect.anything()));
    expect(mockApi).toHaveBeenCalledWith("/receipts/7/retry-apply", expect.anything());
  });

  it("shows Matching pending, and how to resolve it, while matching couldn't run", () => {
    detail = { ...detail, ReceivedReceipt: { ...receipt, matchingPendingSince: "2026-10-02T15:30:00Z" } };
    wrap();
    expect(screen.getByText("Matching pending")).toBeInTheDocument();
    expect(screen.getByText("Matching didn't run because the catalog was unavailable. Run matching now, or map the lines by hand.")).toBeInTheDocument();
  });

  describe("Run matching now", () => {
    const pending = () => ({ ...baseDetail, ReceivedReceipt: { ...receipt, matchingPendingSince: "2026-10-02T15:30:00Z" } });
    /** The receipt as the reload after the run reads it. */
    function afterRun(after: typeof baseDetail) {
      mockApi.mockImplementation(async (path: string) => (path === "/receipts/7" ? after : { id: 7, state: after.ReceivedReceipt.state }));
    }

    it("is offered to inventory managers beside Matching pending", () => {
      detail = pending();
      wrap();
      expect(screen.getByRole("button", { name: "Run matching now" })).toBeInTheDocument();
    });

    it("is not offered to anyone else", () => {
      mockIsManager = false;
      detail = pending();
      wrap();
      expect(screen.queryByRole("button", { name: "Run matching now" })).not.toBeInTheDocument();
    });

    it("is not offered once matching ran", () => {
      wrap();
      expect(screen.queryByRole("button", { name: "Run matching now" })).not.toBeInTheDocument();
    });

    it("runs matching for this receipt and says how many lines it matched", async () => {
      detail = pending();
      afterRun({
        ...baseDetail,
        ReceivedReceiptLineStatus: [
          { ...baseDetail.ReceivedReceiptLineStatus[0], recognitionStatus: "recognized", assignedGtin13: "0000000000017" },
          baseDetail.ReceivedReceiptLineStatus[1],
        ],
      });
      wrap();
      fireEvent.click(screen.getByRole("button", { name: "Run matching now" }));
      await waitFor(() => expect(mockShow).toHaveBeenCalledWith({ message: "1 line matched", color: "green" }));
      expect(mockApi).toHaveBeenCalledWith("/receipts/7/run-matching", { method: "POST" });
    });

    it("says the catalog is still unavailable when matching couldn't run again", async () => {
      detail = pending();
      afterRun(pending());
      wrap();
      fireEvent.click(screen.getByRole("button", { name: "Run matching now" }));
      await waitFor(() => expect(mockShow).toHaveBeenCalledWith({ message: "Catalog still unavailable. Try again later, or map the lines by hand.", color: "gray" }));
    });
  });

  it("shows no Matching pending once matching ran", () => {
    wrap();
    expect(screen.queryByText("Matching pending")).not.toBeInTheDocument();
  });

  it("pushes the receipt straight after a manual proceed", async () => {
    mockApi.mockResolvedValueOnce({ id: 7, state: "applying" }).mockResolvedValueOnce({ id: 7, state: "resolved" });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(mockApi.mock.calls.map(([path]) => path)).toEqual(["/receipts/7/proceed", "/receipts/7/apply"]);
  });

  it("doesn't push when the proceed is refused", async () => {
    mockApi.mockRejectedValueOnce(new HttpError("1 line item(s) still unrecognized", 409));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ message: "1 line item(s) still unrecognized" })));
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed save open as a red notification", async () => {
    mockApi.mockRejectedValue(new HttpError("Receipt is already being applied", 409));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() =>
      expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ message: "Receipt is already being applied", color: "red", autoClose: false })),
    );
  });
});
