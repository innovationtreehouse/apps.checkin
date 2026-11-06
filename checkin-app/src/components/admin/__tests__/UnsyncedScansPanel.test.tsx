import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { UnsyncedScansPanel } from "../UnsyncedScansPanel";

beforeEach(() => resetRtl());

const ROUTE = "/api/system-status/unsynced-scans";
const scan = {
  id: 4,
  timestamp: "2026-06-01T12:00:00Z",
  location: null,
  reviewReason: "facility_closed",
  scannedValue: null,
  person: { id: 9, name: "Pat Scanner" },
};

describe("UnsyncedScansPanel", () => {
  it("shows the failure, not an all-clear, when the load fails", async () => {
    mockFetchJson({});
    renderWithProviders(<UnsyncedScansPanel />);
    expect(await screen.findByText("Couldn't load unsynced scans")).toBeInTheDocument();
    expect(screen.queryByText(/No scans awaiting review/)).not.toBeInTheDocument();
  });

  it("dismisses a scan and re-reads the queue", async () => {
    let scans = [scan];
    const fetchFn = mockFetchJson({ [ROUTE]: () => ({ scans }) });
    renderWithProviders(<UnsyncedScansPanel />);
    expect(await screen.findByText(/Pat Scanner/)).toBeInTheDocument();

    scans = [];
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText(/No scans awaiting review/)).toBeInTheDocument();
    await waitFor(() => {
      const post = fetchFn.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
      expect(post?.[0]).toBe(`${ROUTE}/4`);
    });
  });
});
