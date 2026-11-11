jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { screen, fireEvent, act } from "@testing-library/react";
import { ModalsProvider } from "@mantine/modals";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import { jsonBody } from "@/test-helpers/jsonBody";
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

  it("shows the failure and a retry when the load is refused", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 403, ...jsonBody({ error: "Forbidden" }) }) as Response) as unknown as typeof fetch;
    renderPage();

    expect(await screen.findByText("Couldn't load compliance data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("labels the likely subject of a blanket-stamped household and never pre-selects one", async () => {
    const fetchMock = mockFetchJson({ "/api/membership-audit/compliance": { blanketStamped } });
    renderPage();

    expect(await screen.findByText("Rivera Household")).toBeInTheDocument();
    expect(screen.getByText(/Submitted their own consent/)).toBeInTheDocument();
    expect(screen.getByText(/No evidence either way/)).toBeInTheDocument();
    // Board ruling B5/B25: the date is never changed in the app, so the list only labels evidence.
    expect(screen.queryByRole("button", { name: "Remove this date" })).not.toBeInTheDocument();
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

  it("lists people with a disputed check, and the list alone is not the empty state", async () => {
    mockFetchJson({
      "/api/membership-audit/compliance": {
        peopleWithDisputedCheck: [{ personId: 30, name: "Pat Lee", householdId: 5, programId: null, programName: null, reason: "BG_DISPUTED" }],
      },
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Background check disputed" })).toBeInTheDocument();
    expect(screen.getByText("Pat Lee")).toBeInTheDocument();
    expect(screen.queryByText(/Everyone is in compliance/)).not.toBeInTheDocument();
  });
});

describe("the Cleared since filter while the list reloads", () => {
  const answer = (body: unknown) => ({ ok: true, status: 200, ...jsonBody(body) }) as Response;
  const household = (name: string) => [{ ...blanketStamped[0], householdName: name }];

  it("stays mounted and focused while the filtered list loads", async () => {
    let finish: () => void = () => {};
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("bgClearedSince")) {
        return new Promise<Response>((resolve) => { finish = () => resolve(answer({ blanketStamped: household("Narrowed Household") })); });
      }
      return answer({ blanketStamped });
    }) as unknown as typeof fetch;
    renderPage();
    await screen.findByText("Rivera Household");

    const input = screen.getByLabelText("Cleared since");
    input.focus();
    fireEvent.change(input, { target: { value: "2026-07-01" } });

    expect(screen.getByLabelText("Cleared since")).toBe(input);
    expect(document.activeElement).toBe(input);
    await act(async () => { finish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(await screen.findByText("Narrowed Household")).toBeInTheDocument();
    expect(screen.getByLabelText("Cleared since")).toBe(input);
  });

  it("keeps the latest date's rows when an earlier date answers last", async () => {
    let finishEarlier: () => void = () => {};
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const since = new URL(String(input), "http://localhost").searchParams.get("bgClearedSince");
      if (since === "2026-06-01") {
        return new Promise<Response>((resolve) => { finishEarlier = () => resolve(answer({ blanketStamped: household("June Household") })); });
      }
      if (since === "2026-07-01") return answer({ blanketStamped: household("July Household") });
      return answer({ blanketStamped });
    }) as unknown as typeof fetch;
    renderPage();
    await screen.findByText("Rivera Household");

    const input = screen.getByLabelText("Cleared since");
    fireEvent.change(input, { target: { value: "2026-06-01" } });
    fireEvent.change(input, { target: { value: "2026-07-01" } });
    expect(await screen.findByText("July Household")).toBeInTheDocument();

    await act(async () => { finishEarlier(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByText("June Household")).not.toBeInTheDocument();
    expect(screen.getByText("July Household")).toBeInTheDocument();
  });
});
