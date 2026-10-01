// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { ModalsProvider } from "@mantine/modals";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import MembershipReviewPage from "../page";

// modals.openConfirmModal is a no-op without a provider, so the confirmed action
// would silently never fire. Wrapped here rather than in the shared harness: several
// suites jest.mock("@mantine/modals") and would get an undefined ModalsProvider.
const renderPage = () => renderWithProviders(<ModalsProvider><MembershipReviewPage /></ModalsProvider>);

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

const queue = {
  queue: [
    {
      id: 100,
      orgMembership: {
        household: {
          name: "The Smiths",
          intakeNotes: "We're volunteer only — no students.",
          householdMembers: [
            { id: 1, name: "Pat Smith", email: "pat@example.com" },
            { id: 2, name: "Sam Smith", email: "sam@example.com" },
          ],
        },
      },
      // One reviewer has already named Pat; nobody has named Sam.
      attestations: [{ subjectPersonId: 1 }],
      _count: { attestations: 1 },
    },
  ],
};

// The same household with no approvals yet — the first-reviewer confirmation.
const firstApprovalQueue = { queue: [{ ...queue.queue[0], id: 101, attestations: [], _count: { attestations: 0 } }] };

const nameSubject = (label: string) => fireEvent.click(screen.getByRole("radio", { name: label }));

describe("membership-ops/review page", () => {
  it("loads and renders the review queue", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": queue });
    renderPage();

    expect(await screen.findByText("The Smiths")).toBeInTheDocument();
    expect(screen.getByText("Pat Smith <pat@example.com>", { exact: false })).toBeInTheDocument();
    // The first approval settled who this review is about, so the second reviewer
    // confirms that person rather than being offered the choice again.
    expect(screen.getByText("This review is for Pat Smith")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("1/2 approvals so far.")).toBeInTheDocument();
    // The applicant's freeform note is surfaced on the card (the volunteer signal).
    expect(screen.getByText("We're volunteer only — no students.")).toBeInTheDocument();
  });

  it("cannot approve a household without naming whose check was reviewed", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": firstApprovalQueue });
    renderPage();
    await screen.findByText("The Smiths");

    expect(screen.getByRole("button", { name: "Attest — approve this person" })).toBeDisabled();
    nameSubject("Sam Smith");
    expect(screen.getByRole("button", { name: "Attest — approve this person" })).toBeEnabled();
  });

  it("approves an attestation", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": queue });
    renderPage();
    await screen.findByText("The Smiths");

    fireEvent.click(screen.getByRole("button", { name: "Attest — approve this person" }));
    // Pat already holds one approval, so naming Pat is the SECOND — the confirm names
    // the consequence of a clearing approve rather than a generic "are you sure?".
    expect(await screen.findByText("Approve the background check clearance?")).toBeInTheDocument();
    expect(screen.getByText(/emails the family/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the queue GET only — nothing posted yet
    fireEvent.click(screen.getByRole("button", { name: "Attest — approve the clearance" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership/reviews",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ processId: 100, result: "APPROVE", isMarkedVolunteer: false, subjectPersonIds: [1] }),
        }),
      ),
    );
    await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Attestation recorded — thank you." })));
  });

  it("cancelling the confirmation posts nothing", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": queue });
    renderPage();
    await screen.findByText("The Smiths");

    fireEvent.click(screen.getByRole("button", { name: "Attest — approve this person" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Approve the background check clearance?")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1); // the queue GET only
  });

  it("confirms a first approval without promising clearance", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": firstApprovalQueue });
    renderPage();
    await screen.findByText("The Smiths");

    nameSubject("Pat Smith");
    fireEvent.click(screen.getByRole("button", { name: "Attest — approve this person" }));
    expect(await screen.findByText("Record your attestation?")).toBeInTheDocument();
    expect(screen.getByText(/A second\s+reviewer must also\s+approve/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Attest" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership/reviews",
        expect.objectContaining({ body: JSON.stringify({ processId: 101, result: "APPROVE", isMarkedVolunteer: false, subjectPersonIds: [1] }) }),
      ),
    );
  });

  it("confirms a rejection too — the note is not the confirmation", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/membership/reviews": firstApprovalQueue });
    renderPage();
    await screen.findByText("The Smiths");

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Record is concerning." } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Reject this background check?")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/membership/reviews",
        expect.objectContaining({
          // A rejection is whole-process: it blocks the household without naming anyone.
          body: JSON.stringify({ processId: 101, result: "REJECT", isMarkedVolunteer: false, note: "Record is concerning.", subjectPersonIds: [] }),
        }),
      ),
    );
  });

  it("shows the forbidden card when the queue endpoint returns 403", async () => {
    setSession({ id: 1, isSysadmin: true });
    global.fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    renderPage();

    expect(await screen.findByText("Background-check review")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is queued", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership/reviews": { queue: [] } });
    renderPage();

    expect(await screen.findByText("Nothing awaiting your review right now.")).toBeInTheDocument();
  });

  it("renders a PERSON_BG row by its subject identity (falls back when the household has no name)", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/membership/reviews": {
        queue: [{
          id: 200,
          subjectPerson: { id: 9, name: "Dana Vol", householdId: 5, household: { name: null } },
          orgMembership: null,
          attestations: [],
          _count: { attestations: 0 },
        }],
      },
    });
    renderPage();

    expect(await screen.findByText("Dana Vol")).toBeInTheDocument();
    expect(screen.getByText("No household on file", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("0/2 approvals so far.")).toBeInTheDocument();
    // The volunteer-only checkbox is a household-application concept — hidden for PERSON_BG.
    expect(screen.queryByText("This is a volunteer only family (no students)")).not.toBeInTheDocument();
    // So is naming a subject: the process already names the person it is about.
    expect(screen.queryByText("Whose check did you review?")).not.toBeInTheDocument();
  });

  it("lists reviews I approved that have not cleared, and lets a board member start one over", async () => {
    setSession({ id: 1, isBoardMember: true });
    // A legacy approval that named nobody: it counts toward nobody, so the review is stuck.
    const stuck = { ...queue.queue[0], id: 300, attestations: [{ subjectPersonId: null }, { subjectPersonId: null }], _count: { attestations: 2 } };
    const fetchMock = mockFetchJson({
      "/api/membership/reviews?mine=1": { queue: [stuck] },
      "/api/membership/reviews": { queue: [] },
      "/api/membership-ops/applications/review-override": { outcome: { status: "PENDING_PAYMENT" } },
    });
    renderPage();
    await screen.findByText("Nothing awaiting your review right now.");
    expect(screen.queryByText("The Smiths")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show incomplete reviews I've already approved" }));
    expect(await screen.findByText("The Smiths")).toBeInTheDocument();
    expect(screen.getByText("names nobody", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start review over" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start over" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("review-override"));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ processId: 300, action: "reset" });
    });
  });

  it("does not offer a reset to a reviewer who is not on the board", async () => {
    setSession({ id: 1, isBackgroundCheckReviewer: true });
    mockFetchJson({
      "/api/membership/reviews?mine=1": { queue: [{ ...queue.queue[0], id: 301 }] },
      "/api/membership/reviews": { queue: [] },
    });
    renderPage();
    await screen.findByText("Nothing awaiting your review right now.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show incomplete reviews I've already approved" }));

    expect(await screen.findByText("A board member can start this review over.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start review over" })).not.toBeInTheDocument();
  });
});
