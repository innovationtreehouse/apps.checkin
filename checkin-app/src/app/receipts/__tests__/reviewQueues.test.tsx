import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptsReviewPage from "@checkin/receipt/pages/review";

let mockSearch = new URLSearchParams();
const mockReplace = jest.fn();
let mockLoaded: { data: unknown; error: string | null } = { data: [], error: null };
const mockUseLoad = jest.fn((path: string | null) => ({ ...mockLoaded, data: path === null ? null : mockLoaded.data, reload: jest.fn() }));

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}));

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => mockUseLoad(path),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ||= () => {};
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLoaded = { data: [], error: null };
});

const wrap = () => render(<MantineProvider><ReceiptsReviewPage /></MantineProvider>);
const otherStates = () => screen.getByRole("textbox", { name: "Other states" });

describe("the review screen's other states", () => {
  it.each([
    ["auto_upload", "?state=auto_upload", "Reading (OCR in progress)"],
    ["uploaded", "?state=uploaded", "Uploaded"],
    ["submitter_review", "?state=submitter_review", "Submitter review"],
    ["receipt_finalized", "?state=receipt_finalized", "Finalized"],
    ["not_pushed", "?state=receipt_finalized&pushed=0", "Finalized, not sent to receiving"],
    ["discarded", "?state=discarded", "Discarded"],
    ["rejected", "?state=rejected", "Rejected"],
  ])("?queue=%s lists %s and names it in the picker", (queue, path, label) => {
    mockSearch = new URLSearchParams(`queue=${queue}`);
    wrap();
    expect(mockUseLoad).toHaveBeenLastCalledWith(path);
    expect(otherStates()).toHaveValue(label);
  });

  it("leaves the picker empty on a finance queue", () => {
    mockSearch = new URLSearchParams("queue=duplicate_flagged");
    wrap();
    expect(mockUseLoad).toHaveBeenLastCalledWith("?state=duplicate_flagged");
    expect(otherStates()).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Duplicates" })).toBeChecked();
  });

  it("lists every receipt on All", () => {
    mockSearch = new URLSearchParams("queue=all");
    wrap();
    expect(mockUseLoad).toHaveBeenLastCalledWith("");
  });

  it("switches to the state picked", async () => {
    mockSearch = new URLSearchParams();
    wrap();
    fireEvent.click(otherStates());
    fireEvent.click(await screen.findByRole("option", { name: "Submitter review" }));
    expect(mockReplace).toHaveBeenCalledWith("/receipts/review?queue=submitter_review", { scroll: false });
  });

  it("carries the state into a receipt opened from it", () => {
    mockSearch = new URLSearchParams("queue=not_pushed");
    mockLoaded = {
      data: [{ id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: null, receiptTotalCents: 1000, state: "receipt_finalized", needsReimbursement: false, isInKind: false, pushedAt: null }],
      error: null,
    };
    wrap();
    expect(screen.getByRole("link", { name: /2026/ })).toHaveAttribute("href", "/receipts/review/r1?queue=not_pushed");
  });

  it("shows a failed load as a red alert naming the error", () => {
    mockSearch = new URLSearchParams("queue=discarded");
    mockLoaded = { data: null, error: "pushed must be 0 or 1" };
    wrap();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load these receipts: pushed must be 0 or 1");
  });
});
