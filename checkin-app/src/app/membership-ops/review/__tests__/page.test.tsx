// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { ModalsProvider } from "@mantine/modals";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { jsonBody } from "@/test-helpers/jsonBody";
import { settleAfter } from "@/test-helpers/settle";
import MembershipReviewPage from "../page";

// modals.openConfirmModal is a no-op without a provider, so the confirmed action
// would silently never fire. Wrapped here rather than in the shared harness: several
// suites jest.mock("@mantine/modals") and would get an undefined ModalsProvider.
const renderPage = () => renderWithProviders(<ModalsProvider><MembershipReviewPage /></ModalsProvider>);

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

const smiths = {
  name: "The Smiths",
  intakeNotes: "We're volunteer only — no students.",
  householdMembers: [
    { id: 1, name: "Pat Smith", email: "pat@example.com" },
    { id: 2, name: "Sam Smith", email: "sam@example.com" },
  ],
};

// A review the Smiths' consent opened: nobody named yet.
const unnamed = { id: 101, subjectPerson: null, requestedForHousehold: smiths, _count: { attestations: 0 } };
// The same review once a first reviewer named Pat.
const named = { id: 100, subjectPerson: { id: 1, name: "Pat Smith", householdId: 7, household: { name: "The Smiths" } }, requestedForHousehold: smiths, _count: { attestations: 1 } };

const nameSubject = (label: string) => fireEvent.click(screen.getByRole("radio", { name: label }));

describe("membership-ops/review page", () => {
  it("renders a review with no person yet: the household, its leads to name from, and its note", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": { queue: [unnamed] } });
    renderPage();

    expect(await screen.findByText("The Smiths")).toBeInTheDocument();
    expect(screen.getByText("Pat Smith <pat@example.com>", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Whose check did you review?")).toBeInTheDocument();
    expect(screen.getByText("0/2 approvals so far.")).toBeInTheDocument();
    expect(screen.getByText("We're volunteer only — no students.")).toBeInTheDocument();
    expect(screen.getByText("This is a volunteer only family (no students)")).toBeInTheDocument();
  });

  it("renders a named review by its person, with no picker", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": { queue: [named] } });
    renderPage();

    expect(await screen.findByText("Pat Smith")).toBeInTheDocument();
    expect(screen.getByText("Background check for Pat Smith · Household: The Smiths")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("1/2 approvals so far.")).toBeInTheDocument();
  });

  it("cannot approve or reject a review with no person without naming whose check was reviewed", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": { queue: [unnamed] } });
    renderPage();
    await screen.findByText("The Smiths");
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Record is concerning." } });

    expect(screen.getByRole("button", { name: "Attest — approve this person" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    nameSubject("Sam Smith");
    expect(screen.getByRole("button", { name: "Attest — approve this person" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("approves the second time, naming the consequence", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": { queue: [named] } });
    renderPage();
    await screen.findByText("Pat Smith");

    fireEvent.click(screen.getByRole("button", { name: "Attest — approve this person" }));
    expect(await screen.findByText("Approve the background check clearance?")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the queue GET only — nothing posted yet
    fireEvent.click(screen.getByRole("button", { name: "Attest — approve the clearance" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership/reviews",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ processId: 100, result: "APPROVE", isMarkedVolunteerFamily: false, subjectPersonIds: [] }),
        }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Attestation recorded — thank you." })));
  });

  it("cancelling the confirmation posts nothing", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": { queue: [named] } });
    renderPage();
    await screen.findByText("Pat Smith");

    fireEvent.click(screen.getByRole("button", { name: "Attest — approve this person" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Approve the background check clearance?")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1); // the queue GET only
  });

  it("a first approval names the lead and sends the volunteer tick", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": { queue: [unnamed] } });
    renderPage();
    await screen.findByText("The Smiths");

    nameSubject("Pat Smith");
    fireEvent.click(screen.getByRole("checkbox", { name: "This is a volunteer only family (no students)" }));
    fireEvent.click(screen.getByRole("button", { name: "Attest — approve this person" }));
    expect(await screen.findByText("Record your attestation?")).toBeInTheDocument();
    expect(screen.getByText(/A second reviewer must also approve/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Attest" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership/reviews",
        expect.objectContaining({ body: JSON.stringify({ processId: 101, result: "APPROVE", isMarkedVolunteerFamily: true, subjectPersonIds: [1] }) }),
      ),
    );
  });

  it("a first rejection names the lead too", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": { queue: [unnamed] } });
    renderPage();
    await screen.findByText("The Smiths");

    nameSubject("Sam Smith");
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Record is concerning." } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Reject this background check?")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership/reviews",
        expect.objectContaining({
          body: JSON.stringify({ processId: 101, result: "REJECT", isMarkedVolunteerFamily: false, note: "Record is concerning.", subjectPersonIds: [2] }),
        }),
      ),
    );
  });

  it("shows the forbidden card when the queue endpoint returns 403", async () => {
    setSession({ id: 1, isSysadmin: true });
    global.fetch = jest.fn(async () => ({ ok: false, status: 403, ...jsonBody(({})) })) as unknown as typeof fetch;
    renderPage();

    expect(await screen.findByText("Background-check review")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is queued", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": { queue: [] } });
    renderPage();

    expect(await screen.findByText("Nothing awaiting your review right now.")).toBeInTheDocument();
  });

  it("hides the volunteer tick on a review no household asked for", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership/reviews": {
        queue: [{ id: 200, subjectPerson: { id: 9, name: "Dana Vol", householdId: 5, household: { name: null } }, requestedForHousehold: null, _count: { attestations: 0 } }],
      },
    });
    renderPage();

    expect(await screen.findByText("Dana Vol")).toBeInTheDocument();
    expect(screen.getByText("No household on file", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("This is a volunteer only family (no students)")).not.toBeInTheDocument();
    expect(screen.queryByText("Whose check did you review?")).not.toBeInTheDocument();
  });

  it("lists reviews I approved that have not cleared, and lets a board member start one over with a reason, as the wrong person", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({
      "/api/membership/reviews?mine=1": { queue: [{ ...named, id: 300 }] },
      "/api/membership/reviews": { queue: [] },
      "/api/membership-ops/applications/review-override": { outcome: { status: "PENDING_BG_REVIEW" } },
    });
    renderPage();
    await screen.findByText("Nothing awaiting your review right now.");

    fireEvent.click(screen.getByRole("checkbox", { name: "Show incomplete reviews I've already approved" }));
    expect(await screen.findByText("Pat Smith")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start review over" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "A reason is required to start a review over." }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("review-override"))).toBe(false);

    fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: " report is Sam's " } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /names the wrong person/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("review-override"));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ processId: 300, action: "reset", reason: "report is Sam's", wrongPerson: true });
    });
  });

  it("lets a reviewer undo their own approval, with a reason", async () => {
    setSession({ id: 1, isBackgroundCheckReviewer: true });
    const fetchMock = mockFetchJson({
      "/api/membership/reviews/undo": {},
      "/api/membership/reviews?mine=1": { queue: [{ ...named, id: 302 }] },
      "/api/membership/reviews": { queue: [] },
    });
    renderPage();
    await screen.findByText("Nothing awaiting your review right now.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show incomplete reviews I've already approved" }));

    fireEvent.click(await screen.findByRole("button", { name: "Undo my approval" }));
    const dialog = await screen.findByRole("dialog");
    // No reason: the dialog stays open and nothing is sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo my approval" }));
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "A reason is required to undo an approval." }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/undo"))).toBe(false);

    fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "  wrong report  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo my approval" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/undo"));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ processId: 302, reason: "wrong report" });
    });
  });

  it("lets the rejector change their answer to approve behind a confirmation", async () => {
    setSession({ id: 1, isBackgroundCheckReviewer: true });
    const fetchMock = mockFetchJson({
      "/api/membership/reviews?rejected=1": { queue: [{ ...named, id: 303 }] },
      "/api/membership/reviews": { queue: [] },
    });
    renderPage();
    await screen.findByText("Nothing awaiting your review right now.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show blocked reviews I rejected" }));

    fireEvent.click(await screen.findByRole("button", { name: "Change to approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/discards every decision/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change to approve" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/membership/reviews" && init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ processId: 303, result: "APPROVE" });
    });
  });

  it("does not offer a reset to a reviewer who is not on the board", async () => {
    setSession({ id: 1, isBackgroundCheckReviewer: true });
    mockFetchJson({
      "/api/membership/reviews?mine=1": { queue: [{ ...named, id: 301 }] },
      "/api/membership/reviews": { queue: [] },
    });
    renderPage();
    await screen.findByText("Nothing awaiting your review right now.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show incomplete reviews I've already approved" }));

    expect(await screen.findByText("A board member can start this review over.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start review over" })).not.toBeInTheDocument();
  });
});

describe("failed load", () => {
  it("shows an error with a retry, never the empty state", async () => {
    setSession({ id: 1 });
    mockFetchJson({});
    renderPage();

    await settleAfter("/api/membership/reviews");
    expect(screen.queryByText("Nothing awaiting your review right now.")).not.toBeInTheDocument();
    expect(await screen.findByText("Couldn't load the review queue")).toBeInTheDocument();

    mockFetchJson({ "/api/membership/reviews": { queue: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Nothing awaiting your review right now.")).toBeInTheDocument();
  });
});

describe("failed load of a side list", () => {
  it.each([
    ["Show incomplete reviews I've already approved", "?mine=1", "Couldn't load the reviews you approved", "None — every review you approved has cleared."],
    ["Show blocked reviews I rejected", "?rejected=1", "Couldn't load the reviews you rejected", "None — no blocked review carries your rejection."],
  ])("%s shows an error, never the empty text", async (label, query, errorTitle, emptyText) => {
    setSession({ id: 1 });
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const failed = String(input).includes(query);
      const body = failed ? {} : { queue: [] };
      return { ok: !failed, status: failed ? 404 : 200, ...jsonBody(body), text: async () => JSON.stringify(body) } as Response;
    }) as unknown as typeof fetch;
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: label }));
    await settleAfter(query);
    expect(screen.queryByText(emptyText)).not.toBeInTheDocument();
    expect(await screen.findByText(errorTitle)).toBeInTheDocument();
  });
});

describe("Start review over while the reload is in flight", () => {
  it("keeps the button disabled until the list answers", async () => {
    setSession({ id: 1, isBoardMember: true });
    const row = { ...named, id: 400 };
    let finishReload: () => void = () => {};
    let mineReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = (body: unknown) => ({ ok: true, status: 200, ...jsonBody(body) }) as Response;
      if (init?.method === "POST") return answer({});
      if (!String(input).includes("mine=1")) return answer({ queue: [] });
      mineReads += 1;
      if (mineReads === 1) return answer({ queue: [row] });
      return new Promise<Response>((resolve) => { finishReload = () => resolve(answer({ queue: [] })); });
    }) as unknown as typeof fetch;
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Show incomplete reviews I've already approved" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start review over" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "misclick" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
    await waitFor(() => expect(mineReads).toBe(2));

    expect(screen.getByRole("button", { name: "Start review over" })).toBeDisabled();
    finishReload();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start review over" })).not.toBeInTheDocument());
  });
});
