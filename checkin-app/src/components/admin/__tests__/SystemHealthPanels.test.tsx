type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { act, screen, fireEvent } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { invalidateLoads } from "@checkin/component-ui";
import { renderWithProviders, mockFetchJson, resetRtl, setSession } from "@/test-helpers/rtl";
import { SystemVersionBox, BadgeScanChart, SReadDiagnosticsBox, CronRunsBox, KioskHeartbeatBox, ProblemsBox } from "../SystemHealthPanels";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("SystemVersionBox", () => {
  it("shows up to date when the running version matches the latest commit", async () => {
    mockFetchJson({
      "/api/system-status/kiosk-version": { version: "abc1234" },
      "commits/main": { sha: "abc1234" },
    });
    renderWithProviders(<SystemVersionBox />);
    expect(await screen.findByText(/System is up to date/)).toBeInTheDocument();
  });

  it("shows an update banner + commit list when behind main", async () => {
    mockFetchJson({
      "/api/system-status/kiosk-version": { version: "aaa1111" },
      "commits/main": { sha: "bbb2222" },
      "compare/": { commits: [{ sha: "ccc3333", html_url: "https://x/ccc3333", commit: { message: "Fix the thing\nmore detail" } }] },
    });
    renderWithProviders(<SystemVersionBox />);
    expect(await screen.findByText(/Update Available!/)).toBeInTheDocument();
    expect(screen.getByText(/Fix the thing/)).toBeInTheDocument();
  });

  it("does not compare a build with no SHA against GitHub", async () => {
    mockFetchJson({
      "/api/system-status/kiosk-version": { version: "dev" },
      "commits/main": { sha: "bbb2222" },
    });
    renderWithProviders(<SystemVersionBox />);
    expect(await screen.findByText("dev")).toBeInTheDocument();
    expect(screen.queryByText(/Update Available!/)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("BadgeScanChart", () => {
  it("renders the latency chart legend once stats load", async () => {
    mockFetchJson({
      "/api/system-status/health": {
        days: [
          { date: "2026-06-01", count: 10, median: 20, p90: 40, p99: 60 },
          { date: "2026-06-02", count: 12, median: 22, p90: 41, p99: 61 },
          { date: "2026-06-03", count: 9, median: 19, p90: 39, p99: 58 },
        ],
      },
    });
    renderWithProviders(<BadgeScanChart />);
    expect(await screen.findByText("Median")).toBeInTheDocument();
    expect(screen.getByText("P90")).toBeInTheDocument();
    expect(screen.getByText("P99")).toBeInTheDocument();
  });

  it("shows a failure message when the health endpoint answers without data", async () => {
    mockFetchJson({ "/api/system-status/health": {} });
    renderWithProviders(<BadgeScanChart />);
    expect(await screen.findByText("Failed to load metrics.")).toBeInTheDocument();
  });

  it("shows the load failure with a retry when the health endpoint refuses", async () => {
    mockFetchJson({});
    renderWithProviders(<BadgeScanChart />);
    expect(await screen.findByText("Couldn't load metrics")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("SReadDiagnosticsBox", () => {
  it("does not probe until clicked, then renders each step's verdict and code", async () => {
    mockFetchJson({
      "/api/finance-ops/s-read/diagnose": {
        steps: [
          { id: "env", ok: true, detail: 'Resolved via DATABASE_URL + SHOPIFY_READ_DB: database "shopify_read_dev" on db.internal.' },
          { id: "mirror-read", ok: false, code: "42501", detail: "Table exists, but SELECT is denied — grant-holder membership missing." },
          { id: "latest-run", ok: null, detail: "Skipped — an earlier step already failed." },
        ],
      },
    });
    renderWithProviders(<SReadDiagnosticsBox />);

    // On-load the box must be inert — probing wakes the Aurora cluster.
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Run diagnostics/ }));
    expect(await screen.findByText(/SELECT is denied/)).toBeInTheDocument();
    expect(screen.getByText("42501")).toBeInTheDocument();
    expect(screen.getByText("● OK")).toBeInTheDocument();
    expect(screen.getByText("● FAIL")).toBeInTheDocument();
    expect(screen.getByText("● Skipped")).toBeInTheDocument();
  });

  it("shows a failure line when the endpoint itself is unreachable", async () => {
    mockFetchJson({});
    renderWithProviders(<SReadDiagnosticsBox />);
    fireEvent.click(screen.getByRole("button", { name: /Run diagnostics/ }));
    expect(await screen.findByText(/Diagnostics failed to run/)).toBeInTheDocument();
  });
});

/**
 * The panel is the detail view behind the red System Status pill, and it derives its
 * own badge count client-side — so it can drift from countUnhealthyCronJobs and leave
 * the pill saying 2 while the panel it links to shows nothing. It also has to keep
 * the two failures visually distinct: "stopped running" is a scheduler problem,
 * "ran but could not finish" is not.
 */
describe("CronRunsBox", () => {
  const twoJobs = (now: number) => ({
    "/api/system-status/config-health": {
      cronJobs: [
        // Stale: no completed run in over 48h.
        { job: "post-event", lastSuccessAt: new Date(now - 72 * 3600_000).toISOString(), stale: true },
        // Ran two hours ago, but could not process every row.
        { job: "nightly", lastSuccessAt: new Date(now - 2 * 3600_000).toISOString(), stale: false, lastError: "3 item(s) failed" },
      ],
    },
  });

  it("counts a job that ran-but-failed toward the badge, not just the stale one", async () => {
    mockFetchJson(twoJobs(Date.now()));
    renderWithProviders(<CronRunsBox />);

    // 2, not 1 — mirrors countUnhealthyCronJobs, which feeds the nav pill.
    expect(await screen.findByTitle("2 job(s) need attention")).toBeInTheDocument();
  });

  it("shows the failing job as recently-run rather than as stopped", async () => {
    mockFetchJson(twoJobs(Date.now()));
    renderWithProviders(<CronRunsBox />);

    // The error is named, so the row is actionable...
    expect(await screen.findByText(/3 item\(s\) failed/)).toBeInTheDocument();
    // ...but its timestamp is fresh, which is the whole point of the split: this job
    // did run last night, and must not read as "not running".
    expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/3 days ago/)).toBeInTheDocument();
  });
});

describe("KioskHeartbeatBox", () => {
  it("renders last-seen age from the heartbeat envelope", async () => {
    mockFetchJson({
      "/api/system-status/kiosk-heartbeat": {
        heartbeat: {
          SystemMetricLog: [{ metric: "kiosk_last_seen", timestamp: new Date().toISOString(), value: 90 }],
          KioskProtocolSeen: [],
        },
      },
    });
    renderWithProviders(<KioskHeartbeatBox />);
    expect(await screen.findByText(/Kiosk last seen 1m ago/)).toBeInTheDocument();
  });

  const renderHeartbeat = (rows: { metric: string; value: number }[]) => {
    mockFetchJson({
      "/api/system-status/kiosk-heartbeat": {
        heartbeat: {
          SystemMetricLog: rows.map((r) => ({ ...r, timestamp: new Date().toISOString() })),
          KioskProtocolSeen: [],
        },
      },
    });
    renderWithProviders(<KioskHeartbeatBox />);
  };

  it("says it can't confirm the clock with no reading", async () => {
    renderHeartbeat([]);
    expect(await screen.findByText(/Kiosk clock: can't confirm/)).toBeInTheDocument();
  });

  it.each([29, -29])("does not warn at %d seconds", async (value) => {
    renderHeartbeat([{ metric: "kiosk_clock_skew", value }]);
    expect(await screen.findByText(/Kiosk clock agrees with the server/)).toBeInTheDocument();
  });

  it.each([
    [30, /30s ahead of the server/],
    [-30, /30s behind the server/],
    [-300, /5m behind the server/],
  ])("warns at %d seconds", async (value, copy) => {
    renderHeartbeat([{ metric: "kiosk_last_seen", value: 5 }, { metric: "kiosk_clock_skew", value }]);
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.getByText(/Kiosk last seen 5s ago/)).toBeInTheDocument();
  });

  it("shows each stored key's protocol version, marking a key no longer configured", async () => {
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    mockFetchJson({
      "/api/system-status/kiosk-heartbeat": {
        heartbeat: {
          SystemMetricLog: [{ metric: "kiosk_key:aaaaaaaaaaaaaaaa", timestamp: new Date().toISOString(), value: 1 }],
          KioskProtocolSeen: [
            { keyFingerprint: "aaaaaaaaaaaaaaaa", protocolVersion: 6, lastSeenAt: at },
            { keyFingerprint: "bbbbbbbbbbbbbbbb", protocolVersion: 4, lastSeenAt: at },
          ],
        },
      },
    });
    renderWithProviders(<KioskHeartbeatBox />);
    const current = (await screen.findByText("aaaaaaaaaaaaaaaa")).closest("p");
    const removed = screen.getByText("bbbbbbbbbbbbbbbb").closest("p");
    expect(current).toHaveTextContent("protocol v6, last seen 3 hours ago");
    expect(current).not.toHaveTextContent("key removed");
    expect(removed).toHaveTextContent("protocol v4, last seen 3 hours ago (key removed)");
  });

  it("lists a configured key with no stored row as not seen since recording began", async () => {
    mockFetchJson({
      "/api/system-status/kiosk-heartbeat": {
        heartbeat: {
          SystemMetricLog: [{ metric: "kiosk_key:cccccccccccccccc", timestamp: new Date().toISOString(), value: 1 }],
          KioskProtocolSeen: [],
        },
      },
    });
    renderWithProviders(<KioskHeartbeatBox />);
    expect((await screen.findByText("cccccccccccccccc")).closest("p")).toHaveTextContent("not seen since recording began");
  });

  it("shows a failed read at once, without retrying", async () => {
    const fetchFn = mockFetchJson({ "/api/system-status/kiosk-heartbeat": () => { throw new Error("down"); } });
    renderWithProviders(<KioskHeartbeatBox />);
    expect(await screen.findByText("Couldn't load kiosk last-seen")).toBeInTheDocument();
    expect(screen.queryByText(/Kiosk clock/)).not.toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("hides the last clock line when a refresh fails", async () => {
    let down = false;
    mockFetchJson({
      "/api/system-status/kiosk-heartbeat": () => {
        if (down) throw new Error("down");
        return { heartbeat: { SystemMetricLog: [{ metric: "kiosk_clock_skew", value: 0, timestamp: new Date().toISOString() }], KioskProtocolSeen: [] } };
      },
    });
    renderWithProviders(<KioskHeartbeatBox />);
    expect(await screen.findByText(/Kiosk clock agrees with the server/)).toBeInTheDocument();

    down = true;
    act(() => invalidateLoads());

    expect(await screen.findByText("Couldn't load kiosk last-seen")).toBeInTheDocument();
    expect(screen.queryByText(/Kiosk clock/)).not.toBeInTheDocument();
  });

  it("warns for a kiosk refused before it was ever accepted, with no last-seen row", async () => {
    renderHeartbeat([{ metric: "kiosk_clock_skew", value: 90 }]);
    expect(await screen.findByText(/90s ahead of the server/)).toBeInTheDocument();
    expect(screen.getByText(/No kiosk request since this task started/)).toBeInTheDocument();
  });
});

describe("ProblemsBox", () => {
  it("lists each stuck item with its library, step, a link to its page and its time, then each job not on time", async () => {
    mockFetchJson({
      "/api/system-status/config-health": {
        problems: {
          items: [
            { library: "expense", id: "e1", step: "QuickBooks posting", href: "/expense/expenses/e1", failedAt: "2026-11-01T12:00:00.000Z" },
            { library: "workflow mapping", id: "7", step: "catalog event", href: null, failedAt: "2026-11-02T12:00:00.000Z" },
          ],
          unread: ["gifts"],
          notices: [
            { text: "Receipt reading failed 3 times in the last day", href: null },
            { text: "Emails failed to send: 2 in the last day", href: "/system-status/links" },
          ],
        },
        cronJobs: [
          { job: "nightly", lastSuccessAt: "2026-11-07T12:00:00.000Z", stale: false },
          { job: "qbo-posting", lastSuccessAt: "2026-11-03T12:00:00.000Z", stale: true },
        ],
      },
    });
    renderWithProviders(<ProblemsBox />);

    expect((await screen.findByText("e1")).closest("a")).toHaveAttribute("href", "/expense/expenses/e1");
    expect(screen.getByText("7").closest("a")).toBeNull();
    expect(screen.getByText("qbo-posting")).toBeInTheDocument();
    expect(screen.queryByText("nightly")).not.toBeInTheDocument();
    expect(screen.getByText(/Could not read the stuck items in gifts/)).toBeInTheDocument();
    expect(screen.getByText("Receipt reading failed 3 times in the last day").closest("a")).toBeNull();
    expect(screen.getByText("Emails failed to send: 2 in the last day").closest("a")).toHaveAttribute("href", "/system-status/links");
    expect(screen.getByText("6")).toBeInTheDocument();
  });

  it("says failed email sends could not be counted when the email count is unread", async () => {
    mockFetchJson({ "/api/system-status/config-health": { problems: { items: [], unread: ["email"], notices: [] }, cronJobs: [] } });
    renderWithProviders(<ProblemsBox />);
    expect(await screen.findByText("Failed email sends could not be counted.")).toBeInTheDocument();
  });

  it("lists a job whose latest run reported failures, without its error text, and a late one only once", async () => {
    const problems = { items: [], unread: [], notices: [] };
    mockFetchJson({
      "/api/system-status/config-health": {
        problems,
        cronJobs: [
          { job: "reconcile-shopify", lastSuccessAt: "2026-11-07T12:00:00.000Z", stale: false, lastError: "1 item(s) failed", lastErrorAt: "2026-11-07T12:00:00.000Z" },
          { job: "nightly", lastSuccessAt: "2026-11-03T12:00:00.000Z", stale: true, lastError: "boom", lastErrorAt: "2026-11-07T12:00:00.000Z" },
        ],
      },
    });
    renderWithProviders(<ProblemsBox />);

    expect(await screen.findByText("reconcile-shopify")).toBeInTheDocument();
    expect(screen.getByText(/^Last run reported failures/)).toBeInTheDocument();
    expect(screen.getAllByText("nightly")).toHaveLength(1);
    expect(screen.getByText(/^Has not run on time/)).toBeInTheDocument();
    expect(screen.queryByText(/item\(s\) failed|boom/)).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("drops the job once its latest run is clean", async () => {
    mockFetchJson({
      "/api/system-status/config-health": {
        problems: { items: [], unread: [], notices: [] },
        cronJobs: [{ job: "reconcile-shopify", lastSuccessAt: "2026-11-07T12:00:00.000Z", stale: false }],
      },
    });
    renderWithProviders(<ProblemsBox />);
    expect(await screen.findByText("Nothing is stuck.")).toBeInTheDocument();
  });

  const stuck = [
    { library: "expense", id: "e1", step: "QuickBooks posting", href: null, failedAt: "2026-11-01T12:00:00.000Z" },
    { library: "gifts", id: "receipt 4", step: "QuickBooks posting", href: null, failedAt: "2026-11-02T12:00:00.000Z" },
    { library: "receipt", id: "r9", step: "flow", href: null, failedAt: "2026-11-03T12:00:00.000Z" },
  ];
  const retryBodies = (fetchFn: jest.Mock) =>
    fetchFn.mock.calls
      .filter(([url]) => String(url).includes("/problems/retry"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  it("Retry runs one item's step, then refreshes the list", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchFn = mockFetchJson({
      "/api/system-status/config-health": { problems: { items: stuck, unread: [], notices: [] }, cronJobs: [] },
      "/api/system-status/problems/retry": { results: [{ step: "flow", id: "r9", ok: true }] },
    });
    renderWithProviders(<ProblemsBox />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Retry" }))[2]);

    expect(await screen.findByText("1 of 1 retried; 0 still stuck.")).toBeInTheDocument();
    expect(retryBodies(fetchFn)).toEqual([{ library: "receipt", step: "flow", id: "r9" }]);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("config-health"))).toHaveLength(2);
  });

  it("hides Retry on a QuickBooks step from a sysadmin, who still retries the rest", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/system-status/config-health": { problems: { items: stuck, unread: [], notices: [] }, cronJobs: [] } });
    renderWithProviders(<ProblemsBox />);

    expect(await screen.findAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getByText("r9").closest("li")).toContainElement(screen.getByRole("button", { name: "Retry" }));
  });

  it("Retry all sends a sysadmin's retryable items only", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchFn = mockFetchJson({
      "/api/system-status/config-health": { problems: { items: [stuck[0], stuck[2]], unread: [], notices: [] }, cronJobs: [] },
      "/api/system-status/problems/retry": { results: [{ ok: true }] },
    });
    renderWithProviders(<ProblemsBox />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry all" }));

    expect(await screen.findByText("1 of 1 retried; 0 still stuck.")).toBeInTheDocument();
    expect(retryBodies(fetchFn)).toEqual([{ library: "receipt", step: "flow", id: "r9" }]);
  });

  it("hides Retry all from a viewer with nothing they may retry", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/system-status/config-health": { problems: { items: [stuck[0], stuck[1]], unread: [], notices: [] }, cronJobs: [] } });
    renderWithProviders(<ProblemsBox />);

    expect(await screen.findByText("e1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it("Retry all retries every item one at a time in list order, goes on past a refusal and a failure, then refreshes", async () => {
    setSession({ id: 1, isBoardMember: true });
    // The second answers as a refused (403) press does: no results.
    const answers: unknown[] = [{ results: [{ ok: true }] }, { error: "Forbidden" }, { results: [{ ok: false }] }];
    let inFlight = 0;
    let most = 0;
    const fetchFn = mockFetchJson({
      "/api/system-status/config-health": { problems: { items: stuck, unread: [], notices: [] }, cronJobs: [] },
      "/api/system-status/problems/retry": () => answers.shift(),
    });
    const inner = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (input, init) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return inner(input, init);
    });
    renderWithProviders(<ProblemsBox />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry all" }));

    expect(await screen.findByText("1 of 3 retried; 2 still stuck.")).toBeInTheDocument();
    expect(retryBodies(fetchFn)).toEqual(stuck.map(({ library, step, id }) => ({ library, step, id })));
    expect(most).toBe(1);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("config-health"))).toHaveLength(2);
  });

  const dismissBodies = (fetchFn: jest.Mock) =>
    fetchFn.mock.calls
      .filter(([url]) => String(url).includes("/problems/dismiss"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  const expiredMail = { library: "receipt", id: "12", step: "mail message", href: "/receipts/mail", failedAt: "2026-10-01T12:00:00.000Z", expired: true };

  it("Dismiss takes one item off the list, then refreshes it", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchFn = mockFetchJson({
      "/api/system-status/config-health": { problems: { items: stuck, unread: [], notices: [] }, cronJobs: [] },
      "/api/system-status/problems/dismiss": { results: [{ step: "flow", id: "r9", ok: true }] },
    });
    renderWithProviders(<ProblemsBox />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Dismiss" }))[2]);

    await act(async () => {});
    expect(dismissBodies(fetchFn)).toEqual([{ library: "receipt", step: "flow", id: "r9" }]);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("config-health"))).toHaveLength(2);
    expect(notificationsStore.getState().notifications).toEqual([]);
  });

  it("shows Dismiss only where the viewer may retry", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/system-status/config-health": { problems: { items: [...stuck, expiredMail], unread: [], notices: [] }, cronJobs: [] } });
    renderWithProviders(<ProblemsBox />);

    expect(await screen.findAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
    expect(screen.getByText("r9").closest("li")).toContainElement(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("marks expired mail as unreplayable, with Dismiss and no Retry, and leaves it out of Retry all", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchFn = mockFetchJson({
      "/api/system-status/config-health": { problems: { items: [expiredMail, stuck[2]], unread: [], notices: [] }, cronJobs: [] },
      "/api/system-status/problems/retry": { results: [{ ok: true }] },
    });
    renderWithProviders(<ProblemsBox />);

    const row = (await screen.findByText("12")).closest("li") as HTMLElement;
    expect(row).toHaveTextContent("expired, can't be replayed");
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row).toContainElement(screen.getAllByRole("button", { name: "Dismiss" })[0]);

    fireEvent.click(screen.getByRole("button", { name: "Retry all" }));
    expect(await screen.findByText("1 of 1 retried; 0 still stuck.")).toBeInTheDocument();
    expect(retryBodies(fetchFn)).toEqual([{ library: "receipt", step: "flow", id: "r9" }]);
  });

  it("shows a failed Dismiss as a red chip that stays, naming the item and why", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchFn = mockFetchJson({ "/api/system-status/config-health": { problems: { items: [stuck[2]], unread: [], notices: [] }, cronJobs: [] } });
    renderWithProviders(<ProblemsBox />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    await act(async () => {});
    expect(dismissBodies(fetchFn)).toHaveLength(1);
    expect(notificationsStore.getState().notifications).toEqual([
      expect.objectContaining({
        color: "red",
        autoClose: false,
        title: "Could not dismiss receipt, flow: r9",
        message: "It is no longer on the Problems list, so there was nothing to dismiss. The list has been refreshed.",
      }),
    ]);
  });

  it("says so when nothing is stuck", async () => {
    mockFetchJson({ "/api/system-status/config-health": { problems: { items: [], unread: [], notices: [] }, cronJobs: [] } });
    renderWithProviders(<ProblemsBox />);
    expect(await screen.findByText("Nothing is stuck.")).toBeInTheDocument();
  });

  it("shows the failed state when the answer has no problems", async () => {
    mockFetchJson({ "/api/system-status/config-health": { checks: [] } });
    renderWithProviders(<ProblemsBox />);
    expect(await screen.findByText("Unable to load the Problems list.")).toBeInTheDocument();
  });
});
