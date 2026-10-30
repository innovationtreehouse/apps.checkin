import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-helpers/rtl";
import ReceiptPage from "@checkin/workflow-mapping/pages/receipt";

jest.mock("next/navigation", () => ({ useParams: () => ({ id: "7" }) }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1, isInventoryManager: true } } }) }));

let mockLoads: Record<string, unknown> = {};
jest.mock("@checkin/workflow-mapping/components/api", () => ({
  ...jest.requireActual("@checkin/workflow-mapping/components/api"),
  useLoad: (path: string) => ({ data: mockLoads[path] ?? null, error: null, reload: jest.fn() }),
}));

const unstamped = { inventoryAppliedAt: null, expenseAppliedAt: null, donationAppliedAt: null };

function load(receipt: Record<string, unknown>) {
  mockLoads = {
    "/receipts/7": {
      ReceivedReceipt: { id: 7, validationNotes: null, createdAt: "2026-10-02T15:30:00Z", ...unstamped, ...receipt },
      WorkflowReceiptView: {
        vendorName: "Acme", currency: "USD", receiptTotalCents: 1000, receiptDate: "2026-10-01",
        lineItems: [{ receiptLineItemId: 1, lineNumber: 1, description: "Widget", partNumber: null, manufacturer: null, quantity: 2 }],
      },
      ReceivedReceiptLineStatus: [
        { id: 11, receiptLineItemId: 1, recognitionStatus: "recognized", assignedGtin13: "0000000000017", provisionalItemGtin13: null, conversionFactor: 1 },
      ],
    },
  };
}

describe("receipt page line lock", () => {
  it("offers the line actions while the receipt waits for review", () => {
    load({ state: "pending_review" });
    renderWithProviders(<ReceiptPage />);
    expect(screen.getByRole("button", { name: "Associate" })).toBeInTheDocument();
    expect(screen.queryByText("Lines locked")).not.toBeInTheDocument();
  });

  it.each([[{}], [{ inventoryAppliedAt: "2026-10-02T00:00:00Z" }]])(
    "hides the line actions on apply_failed and says why, with Retry still offered (%o)",
    (stamps) => {
      load({ state: "apply_failed", ...stamps });
      renderWithProviders(<ReceiptPage />);
      for (const name of ["Associate", "Propose", "Not inventory"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.getByText("Lines locked")).toBeInTheDocument();
      expect(screen.getByText(/Retry sends the part that failed with the same lines\./)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry apply" })).toBeInTheDocument();
    },
  );
});
