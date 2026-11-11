import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ReceiptQueueList } from "@checkin/receipt/pages/financeQueue";

jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 2, isFinance: true } } }) }));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const row = { id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 7, retailer: "Home Depot", receiptDate: "2026-10-01", receiptTotalCents: 8412, state: "pending_finance_review", needsReimbursement: false, isInKind: false };

describe("the finance review All tab, through the real useLoad", () => {
  it("fetches the unfiltered receipt list and shows its rows", async () => {
    const fetchMock = jest.fn<Promise<Response>, [string]>(async () => new Response(JSON.stringify([row]), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <MantineProvider>
        <ReceiptQueueList queue="" />
      </MantineProvider>,
    );

    expect(await screen.findByText("Home Depot")).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/receipts");
  });
});
