import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ReceiptsReviewPage from "@checkin/receipt/pages/review";

let mockSearch = new URLSearchParams();
const mockReplace = jest.fn();
let mockLoaded: { data: unknown; error: string | null } = { data: [], error: null };
let mockCounts: { data: unknown; error: string | null } = { data: null, error: null };
let mockIsFinance = true;
const mockReloadCounts = jest.fn();
const mockUseLoad = jest.fn((path: string | null) =>
  path === "/queue-counts"
    ? { ...mockCounts, reload: mockReloadCounts }
    : { ...mockLoaded, data: path === null ? null : mockLoaded.data, reload: jest.fn() },
);

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}));

jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useLoad: (path: string | null) => mockUseLoad(path),
  useRoles: () => ({ isFinance: mockIsFinance, isBoard: !mockIsFinance }),
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
  mockCounts = { data: null, error: null };
  mockIsFinance = true;
});

const wrap = () => render(<MantineProvider><ReceiptsReviewPage /></MantineProvider>);
const otherStates = () => screen.getByRole("textbox", { name: "Other states" });

describe("the review screen's other states", () => {
  it.each([
    ["auto_upload", "?state=auto_upload", "Reading (OCR in progress)"],
    ["uploaded", "?state=uploaded", "Uploaded"],
    ["submitter_review", "?state=submitter_review", "Submitter review"],
    ["receipt_finalized", "?state=receipt_finalized", "Finalized"],
    ["not_pushed", "?state=receipt_finalized&pushed=0", "Not delivered to receiving"],
    ["discarded", "?state=discarded", "Discarded"],
    ["rejected", "?state=rejected", "Rejected"],
  ])("?queue=%s lists %s and names it in the picker", (queue, path, label) => {
    mockSearch = new URLSearchParams(`queue=${queue}`);
    wrap();
    expect(mockUseLoad).toHaveBeenCalledWith(path);
    expect(otherStates()).toHaveValue(label);
  });

  it("leaves the picker empty on a finance queue", () => {
    mockSearch = new URLSearchParams("queue=duplicate_flagged");
    wrap();
    expect(mockUseLoad).toHaveBeenCalledWith("?state=duplicate_flagged");
    expect(otherStates()).toHaveValue("");
    expect(screen.getByRole("radio", { name: /^Duplicates/ })).toBeChecked();
  });

  it("lists every receipt on All", () => {
    mockSearch = new URLSearchParams("queue=all");
    wrap();
    expect(mockUseLoad).toHaveBeenCalledWith("");
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

describe("the review screen's queue counts", () => {
  const counts = { byState: { financial_review: 3, validation_failed: 2, submitter_review: 4 }, notPushed: 5, pushGivenUp: 2 };

  it("counts FINANCE's own queues in green and the rest in gray", () => {
    mockCounts = { data: counts, error: null };
    wrap();
    expect(screen.getByRole("radio", { name: /^Finance review/ }).parentElement).toContainElement(screen.getByLabelText("3 to act on"));
    expect(screen.getByRole("radio", { name: /^Totals off/ }).parentElement).toContainElement(screen.getByLabelText("2 in this queue"));
  });

  it("counts every queue in gray for the Board, which reads but does not act", () => {
    mockIsFinance = false;
    mockCounts = { data: counts, error: null };
    wrap();
    expect(screen.getByLabelText("3 in this queue")).toBeInTheDocument();
    expect(screen.queryByLabelText(/to act on/)).not.toBeInTheDocument();
  });

  it("counts the given-up undelivered receipts as FINANCE's to act on", () => {
    mockSearch = new URLSearchParams("queue=not_pushed");
    mockCounts = { data: counts, error: null };
    wrap();
    expect(screen.getAllByLabelText("2 to act on").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("5 in this queue")).not.toBeInTheDocument();
  });

  it("reloads the counts when a receipt write tells the nav to refetch", () => {
    wrap();
    act(() => {
      window.dispatchEvent(new Event("nav-counts-mutated"));
    });
    expect(mockReloadCounts).toHaveBeenCalledTimes(1);
  });

  it("shows a failed count load as a red alert naming the error", () => {
    mockCounts = { data: null, error: "HTTP 500" };
    wrap();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the queue counts: HTTP 500");
  });
});

describe("the not-delivered view", () => {
  it("shows each receipt's latest push failure and marks the ones catch-up gave up on", () => {
    mockSearch = new URLSearchParams("queue=not_pushed");
    const base = { uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, receiptDate: null, receiptTotalCents: 1000, state: "receipt_finalized", needsReimbursement: false, isInKind: false, pushedAt: null };
    mockLoaded = {
      data: [
        { ...base, id: "r1", retailer: "Acme", pushGivenUp: true, lastPushFailedAt: "2026-10-20T12:00:00Z", lastPushFailure: "workflow-mapping down" },
        { ...base, id: "r2", retailer: "Bolt", pushGivenUp: false, lastPushFailedAt: null, lastPushFailure: null },
      ],
      error: null,
    };
    wrap();
    const [acme, bolt] = ["Acme", "Bolt"].map((name) => screen.getByText(name).closest("tr") as HTMLElement);
    expect(acme).toHaveTextContent("Catch-up stopped: re-send by hand");
    expect(acme).toHaveTextContent("workflow-mapping down");
    expect(bolt).not.toHaveTextContent("Catch-up stopped");
    expect(bolt).toHaveTextContent("No failed attempt recorded");
  });
});
