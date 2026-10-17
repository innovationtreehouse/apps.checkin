import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { MatchAuditPanel } from "../MatchAuditPanel";

beforeEach(() => resetRtl());

const AUDIT_URL = "/api/finance-ops/s-read/match-audit";
const TRACK_URL = "/api/finance-ops/s-read/match-audit/track";

describe("MatchAuditPanel", () => {
  it("does not run until clicked, then separates gaps from legitimate manual rows", async () => {
    mockFetchJson({
      [AUDIT_URL]: {
        configured: true,
        configuredVariants: 3,
        variantCoverage: { lines: 6, withVariant: 6 },
        orders: [
          { bucket: "MATCHED", orderLegacyId: "1", name: "#1", customerEmail: "a@x.com", financialStatus: "PAID", totalCents: 5000, discountCodes: [], expected: ["membership"] },
          { bucket: "UNCLAIMED_PAID", orderLegacyId: "2", name: "#2", customerEmail: "b@x.com", financialStatus: "PAID", totalCents: 7500, discountCodes: ["VOL50"], expected: ["program: Robotics"] },
        ],
        memberships: [
          { bucket: "MANUAL_PAYMENT", processId: 3, membershipId: null, householdName: "The Larks", shopifyOrderId: null, manualPaymentByName: "Board Bob" },
          { bucket: "NO_PAYMENT_BASIS", processId: 4, membershipId: null, householdName: "The Wrens", shopifyOrderId: null, manualPaymentByName: null },
          { bucket: "NO_PROCESS", processId: null, membershipId: 5, householdName: "The Finches", shopifyOrderId: null, manualPaymentByName: null },
          { bucket: "ORDER_REVERSED", processId: 6, membershipId: null, householdName: "The Sparrows", shopifyOrderId: "801", manualPaymentByName: null },
        ],
        enrollments: [
          { bucket: "SCHOLARSHIP_APPROVED", programId: 7, programName: "Robotics", personId: 9, personName: "Kid Nine", shopifyOrderId: null, compedByName: null },
          { bucket: "ADMIN_COMPED", programId: 7, programName: "Robotics", personId: 10, personName: "Kid Ten", shopifyOrderId: null, compedByName: "Admin Amy" },
          { bucket: "ORDER_REVERSED", programId: 7, programName: "Robotics", personId: 11, personName: "Kid Eleven", shopifyOrderId: "701", compedByName: null },
          { bucket: "PRE_MIRROR", programId: 7, programName: "Robotics", personId: 12, personName: "Kid Twelve", shopifyOrderId: "50", compedByName: null },
        ],
      },
    });
    renderWithProviders(<MatchAuditPanel />);

    // Inert until asked — the audit sweeps the mirror and wakes the cluster.
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));

    // The gap classes render as rows — unclaimed paid, membership NO_PAYMENT_BASIS,
    // and NO_PROCESS all count as gaps (3 gap(s)); reversed + pre-mirror do not.
    expect(await screen.findByText("3 gap(s)")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("program: Robotics")).toBeInTheDocument();
    expect(screen.getByText("VOL50")).toBeInTheDocument();
    expect(screen.getByText("No order and no manually recorded payment")).toBeInTheDocument();
    expect(screen.getByText("Active membership with no INITIAL/RENEWAL process")).toBeInTheDocument();
    // ...and the manual/scholarship/comped classes are listed with WHO, not flagged as gaps.
    expect(screen.getByText("Payment recorded manually by Board Bob")).toBeInTheDocument();
    expect(screen.getByText("Scholarship / payment plan approved")).toBeInTheDocument();
    expect(screen.getByText("Comped by Admin Amy")).toBeInTheDocument();
    // Reversed rows render informationally, not as a gap.
    expect(screen.getByText("Reversed after activation — already in the exceptions queue")).toBeInTheDocument();
    expect(screen.getByText("Membership process 6")).toBeInTheDocument();
    // Pre-mirror is a count only, no row.
    expect(screen.getByText(/Pre-mirror \(before mirror history\)/)).toBeInTheDocument();
    expect(screen.queryByText("Kid Twelve")).not.toBeInTheDocument();
    // Matched orders stay a count, never a table row.
    expect(screen.queryByText("#1")).not.toBeInTheDocument();
  });

  it("surfaces unpaid variant-matched orders in their own informational table, not as gaps", async () => {
    mockFetchJson({
      [AUDIT_URL]: {
        configured: true, configuredVariants: 3, variantCoverage: { lines: 6, withVariant: 6 },
        orders: [
          { bucket: "UNCLAIMED_UNPAID", orderLegacyId: "9", name: "#9", customerEmail: "u@x.com", financialStatus: "AUTHORIZED", totalCents: 7500, discountCodes: [], expected: ["membership"] },
        ],
        memberships: [], enrollments: [],
      },
    });
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    // Shows the row with its financial status so the auditor sees WHY it's unpaid...
    expect(await screen.findByText("#9")).toBeInTheDocument();
    expect(screen.getByText("AUTHORIZED")).toBeInTheDocument();
    // ...but it is NOT counted as a gap (money not in / no access granted).
    expect(screen.getByText("No gaps")).toBeInTheDocument();
  });

  it("shows a clean badge when nothing is wrong", async () => {
    mockFetchJson({
      [AUDIT_URL]: { configured: true, configuredVariants: 3, variantCoverage: { lines: 6, withVariant: 6 }, orders: [], memberships: [], enrollments: [] },
    });
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText("No gaps")).toBeInTheDocument();
  });

  it("calls out a variant-blind mirror instead of reporting a falsely clean audit", async () => {
    mockFetchJson({
      [AUDIT_URL]: { configured: true, configuredVariants: 3, variantCoverage: { lines: 9, withVariant: 0 }, orders: [], memberships: [], enrollments: [] },
    });
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText(/predates variant mirroring/)).toBeInTheDocument();
  });

  it("calls out partially-backfilled variant coverage — absent orders, not gaps", async () => {
    mockFetchJson({
      [AUDIT_URL]: { configured: true, configuredVariants: 3, variantCoverage: { lines: 10, withVariant: 4 }, orders: [], memberships: [], enrollments: [] },
    });
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText(/6 of 10 mirror order lines still have no variant id/)).toBeInTheDocument();
  });

  it("calls out an unconfigured variant set instead of reporting a falsely clean audit", async () => {
    mockFetchJson({
      [AUDIT_URL]: { configured: true, configuredVariants: 0, variantCoverage: { lines: 6, withVariant: 6 }, orders: [], memberships: [], enrollments: [] },
    });
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText(/No membership or program variant ids are configured/)).toBeInTheDocument();
  });

  it("explains an unwired mirror on a real 503", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "",
    })) as unknown as typeof fetch;
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText(/not wired in this environment/)).toBeInTheDocument();
  });

  it("shows the generic failure message on any other error", async () => {
    mockFetchJson({}); // unmatched URL → 404, the generic catch path
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText(/failed to run/)).toBeInTheDocument();
  });

  it("renders a Track button on each gap row; clicking one posts to the track endpoint, drops the row from the gap table, and lowers the gap count", async () => {
    // TRACK_URL registered first: it is a substring superset of AUDIT_URL, and
    // mockFetchJson matches the first key found in the request URL.
    const fetchMock = mockFetchJson({
      [TRACK_URL]: { tracked: true },
      [AUDIT_URL]: {
        configured: true,
        configuredVariants: 3,
        variantCoverage: { lines: 6, withVariant: 6 },
        orders: [
          { bucket: "UNCLAIMED_PAID", orderLegacyId: "2", name: "#2", customerEmail: "b@x.com", financialStatus: "PAID", totalCents: 7500, discountCodes: [], expected: ["membership"] },
        ],
        memberships: [
          { bucket: "NO_PAYMENT_BASIS", processId: 4, membershipId: null, householdName: "The Wrens", shopifyOrderId: null, manualPaymentByName: null },
        ],
        enrollments: [],
      },
    });
    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText("2 gap(s)")).toBeInTheDocument();

    const trackButtons = screen.getAllByRole("button", { name: "Track" });
    expect(trackButtons).toHaveLength(2); // the order gap row + the membership gap row
    fireEvent.click(trackButtons[0]); // the order row (#2)

    expect(await screen.findByText("1 gap(s)")).toBeInTheDocument();
    expect(screen.queryByText("#2")).not.toBeInTheDocument();

    const trackCall = fetchMock.mock.calls.find(([url]) => url.toString().includes(TRACK_URL));
    expect(trackCall).toBeDefined();
    expect(trackCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(trackCall![1]!.body as string)).toEqual({ kind: "order", shopifyOrderId: "2" });
  });

  it("keeps a gap row when the track request is rejected (stale row, 409)", async () => {
    const auditResult = {
      configured: true,
      configuredVariants: 3,
      variantCoverage: { lines: 6, withVariant: 6 },
      orders: [
        { bucket: "UNCLAIMED_PAID", orderLegacyId: "2", name: "#2", customerEmail: "b@x.com", financialStatus: "PAID", totalCents: 7500, discountCodes: [], expected: ["membership"] },
      ],
      memberships: [],
      enrollments: [],
    };
    // Bespoke fetch stub (mockFetchJson always 200s a matched route): the audit GET
    // succeeds, the track POST 409s — same shape as the "explains an unwired
    // mirror" 503 test above.
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(TRACK_URL)) {
        return { ok: false, status: 409, json: async () => ({ error: "stale" }), text: async () => "" } as Response;
      }
      return { ok: true, status: 200, json: async () => auditResult, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    renderWithProviders(<MatchAuditPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run match audit/ }));
    expect(await screen.findByText("#2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Track" }));

    // Row stays — RTL doesn't mount the Mantine notifications portal by default,
    // so assert on the row surviving rather than the toast text.
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBe(2));
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("1 gap(s)")).toBeInTheDocument();
  });
});
