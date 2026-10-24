import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import AuditLogPage from "@checkin/workflow-mapping/pages/auditLog";

const mockLoadPaths: string[] = [];
const mockApi = jest.fn<Promise<unknown>, [string]>();
let mockRows: unknown[] = [];
// One stable array per path, as useLoad keeps one response per load.
let mockLoads = new Map<string, unknown[]>();

jest.mock("@checkin/workflow-mapping/components/api", () => ({
  ...jest.requireActual("@checkin/workflow-mapping/components/api"),
  useLoad: (path: string) => {
    mockLoadPaths.push(path);
    if (!mockLoads.has(path)) mockLoads.set(path, [...mockRows]);
    return { data: mockLoads.get(path), error: null, reload: jest.fn() };
  },
  api: (path: string) => mockApi(path),
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

const row = (over: Record<string, unknown>) => ({
  id: 1, actorUsername: "Sam", eventType: "receipt_created", receivedReceiptId: 7, lineStatusId: null,
  fromState: null, toState: "pending_review", details: null, createdAt: "2026-10-01T12:00:00Z", ...over,
});

const detail = {
  ReceivedReceipt: { id: 7 },
  WorkflowReceiptView: { lineItems: [{ receiptLineItemId: 100, lineNumber: 3, description: "M3 bolts" }] },
  ReceivedReceiptLineStatus: [{ id: 55, receiptLineItemId: 100 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPaths.length = 0;
  mockLoads = new Map();
  mockRows = [
    row({ id: 2, eventType: "line_associated", lineStatusId: 55, toState: null }),
    row({ id: 1 }),
    row({ id: 3, eventType: "something_new", receivedReceiptId: null, toState: null }),
  ];
  mockApi.mockResolvedValue(detail);
});

const wrap = () => render(<MantineProvider><AuditLogPage /></MantineProvider>);
const rowFor = (label: string) => screen.getByText(label).closest("tr") as HTMLElement;

describe("receiving audit log", () => {
  it("names each event in plain words, and shows an unknown code as is", () => {
    wrap();
    expect(screen.getByText("Line associated with catalog item")).toBeInTheDocument();
    expect(screen.getByText("Receipt received")).toBeInTheDocument();
    expect(screen.getByText("something_new")).toBeInTheDocument();
    expect(screen.queryByText("line_associated")).not.toBeInTheDocument();
  });

  it("shows the line number and description a line event touched, blank for receipt-level events", async () => {
    wrap();
    expect(await within(rowFor("Line associated with catalog item")).findByText("3 · M3 bolts")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/receipts/7");
    expect(mockApi).toHaveBeenCalledTimes(1);
    const lineCol = screen.getAllByRole("columnheader").findIndex((th) => th.textContent === "Line");
    expect(within(rowFor("Receipt received")).getAllByRole("cell")[lineCol]).toHaveTextContent(/^$/);
  });

  it("shows a dash when the receipt's lines can't be loaded", async () => {
    mockApi.mockRejectedValue(new Error("HTTP 422"));
    wrap();
    expect(await within(rowFor("Line associated with catalog item")).findByText("—")).toBeInTheDocument();
  });

  it("reads at most four receipts at a time", async () => {
    mockRows = Array.from({ length: 10 }, (_, i) => row({ id: i + 1, eventType: "line_associated", receivedReceiptId: i + 1, lineStatusId: 55 }));
    let inFlight = 0;
    let peak = 0;
    mockApi.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return detail;
    });
    wrap();
    await waitFor(() => expect(screen.getAllByText("3 · M3 bolts")).toHaveLength(10));
    expect(mockApi).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });

  it("reads 100 rows by default and lets the viewer pick another limit", async () => {
    wrap();
    expect(mockLoadPaths.at(-1)).toBe("/audit-log?limit=100");
    fireEvent.click(screen.getByRole("textbox", { name: "Rows" }));
    fireEvent.click(await screen.findByRole("option", { name: "500" }));
    await waitFor(() => expect(mockLoadPaths.at(-1)).toBe("/audit-log?limit=500"));
  });

  it("reads each receipt again on a new load of the log, so labels follow later edits", async () => {
    wrap();
    expect(await screen.findByText("3 · M3 bolts")).toBeInTheDocument();
    mockApi.mockResolvedValue({ ...detail, WorkflowReceiptView: { lineItems: [{ receiptLineItemId: 100, lineNumber: 3, description: "M4 bolts" }] } });
    fireEvent.click(screen.getByRole("textbox", { name: "Rows" }));
    fireEvent.click(await screen.findByRole("option", { name: "500" }));
    expect(await screen.findByText("3 · M4 bolts")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledTimes(2);
  });
});
