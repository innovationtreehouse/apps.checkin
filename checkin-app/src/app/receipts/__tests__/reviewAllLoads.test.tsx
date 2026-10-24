import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptsReviewPage from "@checkin/receipt/pages/review";

let mockSearch = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
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

const row = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: null,
  receiptTotalCents: 1000, state: "discarded", needsReimbursement: false, isInKind: false,
};

describe("the review screen's fetches", () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const body = url === "/api/receipts/queue-counts" ? { byState: { discarded: 1 }, notPushed: 0, pushGivenUp: 0 } : [row];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  it.each([
    ["all", "/api/receipts"],
    ["not_pushed", "/api/receipts?state=receipt_finalized&pushed=0"],
    ["submitter_review", "/api/receipts?state=submitter_review"],
  ])("?queue=%s fetches %s and lists what comes back", async (queue, url) => {
    mockSearch = new URLSearchParams(`queue=${queue}`);
    render(<MantineProvider><ReceiptsReviewPage /></MantineProvider>);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.anything());
    expect(fetchSpy).toHaveBeenCalledWith("/api/receipts/queue-counts", expect.anything());
  });
});
