jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ModalsProvider } from "@mantine/modals";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import CompliancePage from "../page";

// modals.openConfirmModal is a no-op without a provider, so the confirmed action
// would silently never fire.
const renderPage = () => renderWithProviders(<ModalsProvider><CompliancePage /></ModalsProvider>);

beforeEach(() => resetRtl());

const blanketStamped = [
  {
    processId: 7,
    householdId: 3,
    householdName: "Rivera Household",
    bgClearedAt: "2026-07-14T00:00:00.000Z",
    consentRecorded: true,
    leads: [
      { personId: 11, name: "Alex Rivera", email: "alex@example.com", likelySubject: true },
      { personId: 12, name: "Sam Rivera", email: "sam@example.com", likelySubject: false },
    ],
  },
];

describe("membership-audit/compliance page", () => {
  pinTimezone();

  it("renders a UTC-midnight lastBackgroundCheck as its own calendar day, not the day before", async () => {
    mockFetchJson({
      "/api/membership-audit/compliance": {
        households: [{ id: 1, name: "The Days", reasons: ["STALE_BG"], lastBackgroundCheck: "2024-08-15T00:00:00.000Z", leads: [] }],
      },
    });
    const { container } = renderWithProviders(<CompliancePage />);
    await screen.findByText("The Days");

    expect(container.textContent).toContain("8/15/2024");
    expect(container.textContent).not.toContain("8/14/2024");
  });

  it("renders the everyone-in-compliance empty state", async () => {
    mockFetchJson({ "/api/membership-audit/compliance": {} });
    renderPage();

    expect(await screen.findByText(/Everyone is in compliance/)).toBeInTheDocument();
  });

  it("renders the network-error alert when the fetch rejects", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    renderPage();

    expect(await screen.findByText("Network error loading compliance data.")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to load"), expect.anything());
    spy.mockRestore();
  });

  it("labels the likely subject of a blanket-stamped household and never pre-selects one", async () => {
    const fetchMock = mockFetchJson({ "/api/membership-audit/compliance": { blanketStamped } });
    renderPage();

    expect(await screen.findByText("Rivera Household")).toBeInTheDocument();
    expect(screen.getByText(/Submitted their own consent/)).toBeInTheDocument();
    expect(screen.getByText(/No evidence either way/)).toBeInTheDocument();
    // Both leads get a button — the evidence is a label, not a decision.
    expect(screen.getAllByRole("button", { name: "Remove this date" })).toHaveLength(2);
    // The board's confirmed cutoff is the default, so the list starts narrowed.
    // Unfiltered on load: a list that already hides everything before the cutoff
    // cannot be used to confirm the cutoff.
    expect(fetchMock.mock.calls[0][0]).not.toContain("bgClearedSince");
  });

  it("reloads with the Cleared since date when it changes", async () => {
    const fetchMock = mockFetchJson({ "/api/membership-audit/compliance": { blanketStamped } });
    renderPage();
    await screen.findByText("Rivera Household");

    fireEvent.change(screen.getByLabelText("Cleared since"), { target: { value: "2026-07-01" } });

    expect(await screen.findByText("Rivera Household")).toBeInTheDocument();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/membership-audit/compliance?bgClearedSince=2026-07-01");
  });

  it("clears one lead's date through the existing board-gated PUT", async () => {
    const fetchMock = mockFetchJson({
      "/api/membership-audit/compliance": { blanketStamped },
      "/api/membership-ops/participants/12": { ok: true },
    });
    renderPage();
    await screen.findByText("Rivera Household");

    fireEvent.click(screen.getAllByRole("button", { name: "Remove this date" })[1]);
    expect(await screen.findByText("Remove this background-check date?")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove the date" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership-ops/participants/12",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ lastBackgroundCheck: null }) }),
      ),
    );
    expect(await screen.findByText("Date cleared")).toBeInTheDocument();
  });

  it("shows merge-inherited dates as a separate, permanent list", async () => {
    mockFetchJson({
      "/api/membership-audit/compliance": {
        mergeInheritedBgChecks: [
          { personId: 20, name: "Jo Chen", householdId: 4, lastBackgroundCheck: "2026-06-01T00:00:00.000Z", fromName: "Jo Chen (duplicate)" },
        ],
      },
    });
    renderPage();

    expect(await screen.findByText("Jo Chen")).toBeInTheDocument();
    expect(screen.getByText(/from Jo Chen \(duplicate\)/)).toBeInTheDocument();
    expect(screen.getByText("Unverified provenance")).toBeInTheDocument();
  });
});
