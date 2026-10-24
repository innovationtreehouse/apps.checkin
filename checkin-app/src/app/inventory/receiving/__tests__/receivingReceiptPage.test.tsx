import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptPage from "@checkin/workflow-mapping/pages/receipt";

jest.mock("next/navigation", () => ({ useParams: () => ({ id: "7" }) }));
const mockShow = jest.fn();
const mockApi = jest.fn();

jest.mock("@mantine/notifications", () => ({ notifications: { show: (...args: unknown[]) => mockShow(...args) } }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1, isInventoryManager: true } } }) }));

const receipt = {
  id: 7, state: "pending_review", validationNotes: null, createdAt: "2026-10-02T15:30:00Z",
  inventoryAppliedAt: null, expenseAppliedAt: null, donationAppliedAt: null,
};
let detail = {
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
    { id: 11, receiptLineItemId: 1, recognitionStatus: "unrecognized", assignedGtin13: null, provisionalItemGtin13: null, conversionFactor: 1 },
    { id: 12, receiptLineItemId: 2, recognitionStatus: "non_inventory", assignedGtin13: null, provisionalItemGtin13: null, conversionFactor: 1 },
  ],
};

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
  detail = { ...detail, ReceivedReceipt: receipt };
});

const wrap = () => render(<MantineProvider><ReceiptPage /></MantineProvider>);

/** The Mapping cell of the line whose row matches `name`. */
const mappingCell = (name: RegExp) => within(screen.getByRole("row", { name })).getAllByRole("cell")[6];

/** The value printed under a header field's label; the selector skips the table's same-named column header. */
const field = (label: string) => screen.getByText(label, { selector: "p" }).nextElementSibling?.textContent;

describe("the receiving page for one receipt", () => {
  it("shows the receipt's money and identity in the header", () => {
    wrap();
    expect(field("Total")).toBe("$54.32");
    expect(field("Tax")).toBe("$3.21");
    expect(field("Shipping")).toBe("$8.99");
    expect(field("Discount")).toBe("−$2.50");
    expect(field("Receipt id")).toBe("rcpt-abc-123");
    expect(field("Received")).toBe(new Date("2026-10-02T15:30:00Z").toLocaleString());
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

  it("shows an opened line's details beside its mapping form", () => {
    wrap();
    const row = screen.getByRole("row", { name: /Wood glue/ });
    fireEvent.click(within(row).getByRole("button", { name: "Propose" }));
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

  it("pushes the receipt straight after a manual proceed", async () => {
    mockApi.mockResolvedValueOnce({ id: 7, state: "applying" }).mockResolvedValueOnce({ id: 7, state: "resolved" });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(mockApi.mock.calls.map(([path]) => path)).toEqual(["/receipts/7/proceed", "/receipts/7/apply"]);
  });

  it("doesn't push when the proceed is refused", async () => {
    mockApi.mockRejectedValueOnce(new Error("1 line item(s) still unrecognized"));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() => expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ message: "1 line item(s) still unrecognized" })));
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed save open as a red notification", async () => {
    mockApi.mockRejectedValue(new Error("Receipt is already being applied"));
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    await waitFor(() =>
      expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ message: "Receipt is already being applied", color: "red", autoClose: false })),
    );
  });
});
