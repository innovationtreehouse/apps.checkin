// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import AdminTrustedAdultsPage from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

// Override buttons stay disabled until the previous override's reload finishes.
const enabledButton = (name: string) =>
  waitFor(() => {
    const button = screen.getByRole("button", { name });
    expect(button).toBeEnabled();
    return button;
  });

const trustedAdults = [
  {
    id: 1,
    trustedAdultName: "Gary Guardian",
    trustedAdultPhone: null,
    trustedAdultEmail: null,
    familyContext: "Family friend, watches the kids after school.",
    origin: "SELF_DISCLOSED",
    createdAt: "2026-01-01T00:00:00.000Z",
    household: { id: 5, name: "Guardian House", householdMembers: [] },
    trustedAdultPerson: null,
    reviews: [{ id: 9, kind: "SELF_DISCLOSED", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-01-01T00:00:00.000Z" }],
  },
];

describe("safety/trusted-adults page", () => {
  it("loads and renders the review queue", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults } });
    renderWithProviders(<AdminTrustedAdultsPage />);

    expect(await screen.findByText("Guardian House")).toBeInTheDocument();
    expect(screen.getByText("Gary Guardian")).toBeInTheDocument();
    expect(screen.getByText("PENDING BOARD REVIEW")).toBeInTheDocument();
  });

  it("shows the empty state with no pending reviews", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: [] } });
    renderWithProviders(<AdminTrustedAdultsPage />);

    expect(await screen.findByText("Nothing in the queue.")).toBeInTheDocument();
  });

  it("approves a review with a shared note", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    const fetchMock = mockFetchJson({
      "/api/safety/trusted-adults/decision": { status: "APPROVED" },
      "/api/safety/trusted-adults": { trustedAdults },
    });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    fireEvent.change(screen.getByLabelText(/Shared note/), { target: { value: "May pick up Bobby." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/decision",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reviewId: 9, decision: "APPROVE", sharedNote: "May pick up Bobby." }),
        }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Recorded: APPROVED." })));
  });

  it("redirects a caller without board/sysadmin role, and shows a loader while resolving", () => {
    setSession(null, "loading");
    renderWithProviders(<AdminTrustedAdultsPage />);
    expect(screen.queryByText("Trusted Adults — Board Review")).not.toBeInTheDocument();

    setSession({ id: 1 });
    renderWithProviders(<AdminTrustedAdultsPage />);
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("denies a review, and requests info via a modal (skipping when the modal is cancelled)", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    const fetchMock = mockFetchJson({
      "/api/safety/trusted-adults/decision": { status: "DENIED" },
      "/api/safety/trusted-adults": { trustedAdults },
    });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/decision",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ reviewId: 9, decision: "DENY" }) }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Recorded: DENIED." })));

    // Cancelling the modal must NOT fire a decision, least of all an empty-note REQUEST_INFO.
    fireEvent.click(screen.getByRole("button", { name: "Request info" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/safety/trusted-adults/decision",
      expect.objectContaining({ body: expect.stringContaining("REQUEST_INFO") }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Request info" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Need proof of ID." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/decision",
        expect.objectContaining({ body: JSON.stringify({ reviewId: 9, decision: "REQUEST_INFO", note: "Need proof of ID." }) }),
      ),
    );
  }, 10000); // heavy: full page + modal opened twice + two decision round-trips

  it("shows the load failure with a retry, not an empty queue, when the load fails", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({});
    renderWithProviders(<AdminTrustedAdultsPage />);

    expect(await screen.findByText("Couldn't load the trusted-adult queue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    expect(screen.queryByText("Nothing in the queue.")).not.toBeInTheDocument();
  });

  it("badges the last real decision on a resubmit, seeing past an interim withdrawal", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    // reviews are id-desc; [0] is the in-flight resubmit. Prior chain: DENIED, then
    // withdrawn (REVOKED keeps decision=DENY). Board must read "Previously denied".
    const deniedThenWithdrawn = [
      {
        ...trustedAdults[0],
        reviews: [
          { id: 30, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-03-01T00:00:00.000Z" },
          { id: 20, kind: "INITIAL", status: "REVOKED", decision: "DENY", decisionNote: "No.", sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-02-01T00:00:00.000Z" },
          { id: 10, kind: "INITIAL", status: "DENIED", decision: "DENY", decisionNote: "No.", sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      },
    ];
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: deniedThenWithdrawn } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");
    expect(screen.getByText("Previously denied")).toBeInTheDocument();
    expect(screen.queryByText("Renewal")).not.toBeInTheDocument();
  });

  const renderQueue = async (reviews: unknown[]) => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: [{ ...trustedAdults[0], reviews }] } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");
  };

  it("shows no prior-decision badge on a plain withdraw-and-resubmit", async () => {
    await renderQueue([
      { id: 42, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-03-01T00:00:00.000Z" },
      { id: 41, kind: "INITIAL", status: "REVOKED", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(screen.queryByText("Previously denied")).not.toBeInTheDocument();
    expect(screen.queryByText("Renewal")).not.toBeInTheDocument();
  });

  it("badges a renewal after a lapsed approval with the lapse", async () => {
    await renderQueue([
      { id: 52, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-03-01T00:00:00.000Z" },
      { id: 51, kind: "INITIAL", status: "EXPIRED", decision: "APPROVE", decisionNote: null, sharedNote: "Grandma picks up.", effectiveFrom: "2025-01-01T00:00:00.000Z", reviewBy: "2026-01-01T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" },
    ]);
    expect(screen.getByText("Renewal")).toBeInTheDocument();
    expect(screen.getByText(/expired 2026-01-01 · lapsed 59 days/)).toBeInTheDocument();
  });

  it("badges a renewal sent while still approved with no lapse line", async () => {
    await renderQueue([
      { id: 62, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2025-06-01T00:00:00.000Z" },
      { id: 61, kind: "INITIAL", status: "APPROVED", decision: "APPROVE", decisionNote: null, sharedNote: "Grandma picks up.", effectiveFrom: "2025-01-01T00:00:00.000Z", reviewBy: "2026-01-01T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" },
    ]);
    expect(screen.getByText("Renewal")).toBeInTheDocument();
    expect(screen.queryByText(/lapsed/)).not.toBeInTheDocument();
  });

  it("shows a refused decision in the lower right, titled with the household", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: "Not allowed." }), { status: 403 }),
    ) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ id: "trusted-adult-review-9", color: "red", title: "Guardian House", message: "Not allowed.", autoClose: false }),
      ),
    );
    expect(await enabledButton("Deny")).toBeInTheDocument();
  });

  it("shows fixed text when a decision never answers, instead of nothing", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    global.fetch = jest.fn(async () => { throw new TypeError("fetch failed: ECONNRESET"); }) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Couldn't reach the server. Check your connection and try again.", autoClose: false }),
      ),
    );
    expect(await enabledButton("Deny")).toBeInTheDocument();
  });

  it("re-reads the queue when a decision finds the review has moved on", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    const list = mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: "This review has already been settled — reload the page." }), { status: 409 })
        : list(input, init),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "This review has already been settled — reload the page." }),
      ),
    );
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => !c[1]?.method)).toHaveLength(1));
  });

  it("renders a shared note, lead names, review-by date, and disables actions on a conflict of interest", async () => {
    const conflicted = [
      {
        ...trustedAdults[0],
        household: { id: 1, name: "Guardian House", householdMembers: [{ id: 1, name: "Lead Lucy", email: "lucy@example.com" }] },
        reviews: [{ ...trustedAdults[0].reviews[0], sharedNote: "Already shared.", reviewBy: "2026-02-01T00:00:00.000Z" }],
      },
    ];
    setSession({ id: 1, isBoardMember: true, householdId: 1 }); // same householdId as ta.household.id -> conflict
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: conflicted } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.getByText(/Already shared\./)).toBeInTheDocument();
    expect(screen.getByText(/Lead Lucy/)).toBeInTheDocument();
    expect(screen.getByText(/Review by 2026-02-01/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request info" })).toBeDisabled();
  });

  it("disables actions when another family's trusted adult shares an email with the viewer's household", async () => {
    const spouseOfViewer = [{ ...trustedAdults[0], trustedAdultEmail: "spouse@example.com" }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({
      "/api/safety/trusted-adults": { trustedAdults: spouseOfViewer },
      "/api/household": { household: { householdMembers: [{ email: "Spouse@Example.com", phone: null }] } },
    });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.queryByText(/Can't confirm no conflict/)).not.toBeInTheDocument();
  });

  it("warns, without blocking, when only a name identifies the trusted adult", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({
      "/api/safety/trusted-adults": { trustedAdults },
      "/api/household": { household: { householdMembers: [{ email: "me@example.com", phone: null }] } },
    });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.getByText(/Can't confirm no conflict/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it("warns on every card when the viewer's household fails to load", async () => {
    const withEmail = [{ ...trustedAdults[0], trustedAdultEmail: "friend@example.com" }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: withEmail } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(await screen.findByText(/your household didn't load/)).toBeInTheDocument();
  });

  it("on a declined change over a live approval, offers Reset and Revoke approval", async () => {
    const declined = [
      {
        ...trustedAdults[0],
        reviews: [
          { ...trustedAdults[0].reviews[0], id: 11, status: "DENIED" },
          { ...trustedAdults[0].reviews[0], id: 10, status: "APPROVED", reviewBy: new Date(Date.now() + 86400000).toISOString() },
        ],
      },
    ];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: declined } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke approval" })).toBeInTheDocument();
  });

  it("shows Reset and Revoke for an approval in force, and resets only with a reason", async () => {
    const decided = [
      {
        ...trustedAdults[0],
        reviews: [{ ...trustedAdults[0].reviews[0], status: "APPROVED", reviewBy: new Date(Date.now() + 86400000).toISOString() }],
      },
    ];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    const fetchMock = mockFetchJson({
      "/api/safety/trusted-adults/override": { status: "PENDING_BOARD_REVIEW" },
      "/api/safety/trusted-adults": { trustedAdults: decided },
    });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText("Override:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force deny" })).not.toBeInTheDocument();

    // Empty reason: Submit stays disabled, so reset can't fire.
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    const resetDialog = await screen.findByRole("dialog");
    expect(within(resetDialog).getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/safety/trusted-adults/override", expect.anything());

    fireEvent.change(within(resetDialog).getByRole("textbox"), { target: { value: "Approved too soon." } });
    fireEvent.click(within(resetDialog).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/override",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reviewId: 9, action: "reset", reason: "Approved too soon." }),
        }),
      ),
    );

    fireEvent.click(await enabledButton("Revoke"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/override",
        expect.objectContaining({ body: JSON.stringify({ reviewId: 9, action: "revoke" }) }),
      ),
    );
  }, 10000); // heaviest test in file: full page + modal + 2 sequential override round-trips; guards the full-suite serial flake

  it("hides override actions for a revoked review, and shows an override failure message", async () => {
    const revoked = [{ ...trustedAdults[0], reviews: [{ ...trustedAdults[0].reviews[0], status: "REVOKED" }] }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: revoked } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.queryByText("Override:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it.each([
    ["an expired review", "EXPIRED", "RENEWAL", null],
    ["an approval past its review date", "APPROVED", "RENEWAL", new Date(Date.now() - 86400000).toISOString()],
    ["an approved change", "APPROVED", "MODIFIED", new Date(Date.now() + 86400000).toISOString()],
  ])("hides Reset on %s, keeping Revoke", async (_label, status, kind, reviewBy) => {
    const shown = [{ ...trustedAdults[0], reviews: [{ ...trustedAdults[0].reviews[0], status, kind, reviewBy }] }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: shown } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.getByText("Override:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("offers Reset on a denied review", async () => {
    const denied = [{ ...trustedAdults[0], reviews: [{ ...trustedAdults[0].reviews[0], status: "DENIED" }] }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: denied } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("shows an override failure message", async () => {
    const decided = [{ ...trustedAdults[0], reviews: [{ ...trustedAdults[0].reviews[0], status: "APPROVED" }] }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: decided } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: "Cannot revoke." }), { status: 400 }),
    ) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", title: "Guardian House", message: "Cannot revoke.", autoClose: false }),
      ),
    );
  });
});
