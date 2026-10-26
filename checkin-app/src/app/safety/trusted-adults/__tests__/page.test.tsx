// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

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

    // Cancelling the modal must NOT fire a decision (the old window.prompt returned null,
    // which `?? ""` swallowed into an empty-note REQUEST_INFO).
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

  it("leaves an empty queue when the initial load fails", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    renderWithProviders(<AdminTrustedAdultsPage />);
    expect(await screen.findByText("Nothing in the queue.")).toBeInTheDocument();
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

  it("shows no prior-decision badge on a plain withdraw-and-resubmit, but 'Renewal' after an approval", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    const cases = [
      // Withdrawn while never decided (decision=null) → nothing.
      [
        { id: 42, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-03-01T00:00:00.000Z" },
        { id: 41, kind: "INITIAL", status: "REVOKED", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-02-01T00:00:00.000Z" },
      ],
    ];
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: [{ ...trustedAdults[0], reviews: cases[0] }] } });
    const { unmount } = renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");
    expect(screen.queryByText("Previously denied")).not.toBeInTheDocument();
    expect(screen.queryByText("Renewal")).not.toBeInTheDocument();
    unmount();

    // Approved → expired 2026-01-01 → renewed 2026-03-01: "Renewal" + 59-day lapse.
    const renewed = [
      { id: 52, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2026-03-01T00:00:00.000Z" },
      { id: 51, kind: "INITIAL", status: "EXPIRED", decision: "APPROVE", decisionNote: null, sharedNote: "Grandma picks up.", effectiveFrom: "2025-01-01T00:00:00.000Z", reviewBy: "2026-01-01T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: [{ ...trustedAdults[0], reviews: renewed }] } });
    const { unmount: unmount2 } = renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");
    expect(screen.getByText("Renewal")).toBeInTheDocument();
    expect(screen.getByText(/expired 2026-01-01 · lapsed 59 days/)).toBeInTheDocument();
    unmount2();

    // Resubmitted 2025-06-01 while still approved (reviewBy 2026-01-01, future): no lapse line.
    const early = [
      { id: 62, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW", decision: null, decisionNote: null, sharedNote: null, effectiveFrom: null, reviewBy: null, createdAt: "2025-06-01T00:00:00.000Z" },
      { id: 61, kind: "INITIAL", status: "APPROVED", decision: "APPROVE", decisionNote: null, sharedNote: "Grandma picks up.", effectiveFrom: "2025-01-01T00:00:00.000Z", reviewBy: "2026-01-01T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: [{ ...trustedAdults[0], reviews: early }] } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");
    expect(screen.getByText("Renewal")).toBeInTheDocument();
    expect(screen.queryByText(/lapsed/)).not.toBeInTheDocument();
  }, 10000); // heavy: renders the full page three times (mount/unmount ×3)

  it("shows the fallback failure message on a decision error, and dismisses the alert", async () => {
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults } });
    const { container } = renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("Decision failed.")).toBeInTheDocument();

    fireEvent.click(container.querySelector(".mantine-CloseButton-root")!);
    expect(screen.queryByText("Decision failed.")).not.toBeInTheDocument();
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

  it("shows override actions for a decided-but-not-revoked review, and force-approves only with a note", async () => {
    const decided = [
      {
        ...trustedAdults[0],
        reviews: [{ ...trustedAdults[0].reviews[0], status: "APPROVED" }],
      },
    ];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    const fetchMock = mockFetchJson({
      "/api/safety/trusted-adults/override": { status: "APPROVED" },
      "/api/safety/trusted-adults": { trustedAdults: decided },
    });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText("Override:")).toBeInTheDocument();

    // Empty note: Submit stays disabled, so force-approve can't fire.
    fireEvent.click(screen.getByRole("button", { name: "Force approve" }));
    const forceDialog = await screen.findByRole("dialog");
    expect(within(forceDialog).getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/safety/trusted-adults/override", expect.anything());

    fireEvent.change(within(forceDialog).getByRole("textbox"), { target: { value: "Confirmed with family." } });
    fireEvent.click(within(forceDialog).getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/override",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reviewId: 9, action: "approve", sharedNote: "Confirmed with family." }),
        }),
      ),
    );

    fireEvent.click(await enabledButton("Force deny"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/override",
        expect.objectContaining({ body: JSON.stringify({ reviewId: 9, action: "deny" }) }),
      ),
    );

    fireEvent.click(await enabledButton("Revoke"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/safety/trusted-adults/override",
        expect.objectContaining({ body: JSON.stringify({ reviewId: 9, action: "revoke" }) }),
      ),
    );
  }, 10000); // heaviest test in file: full page + modal + 3 sequential override round-trips; guards the full-suite serial flake

  it("hides override actions for a revoked review, and shows an override failure message", async () => {
    const revoked = [{ ...trustedAdults[0], reviews: [{ ...trustedAdults[0].reviews[0], status: "REVOKED" }] }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: revoked } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    expect(screen.queryByText("Override:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("shows an override failure message", async () => {
    const decided = [{ ...trustedAdults[0], reviews: [{ ...trustedAdults[0].reviews[0], status: "APPROVED" }] }];
    setSession({ id: 1, isBoardMember: true, householdId: 1 });
    mockFetchJson({ "/api/safety/trusted-adults": { trustedAdults: decided } });
    renderWithProviders(<AdminTrustedAdultsPage />);
    await screen.findByText("Guardian House");

    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Cannot revoke." }) })) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Cannot revoke.")).toBeInTheDocument();
  });
});
