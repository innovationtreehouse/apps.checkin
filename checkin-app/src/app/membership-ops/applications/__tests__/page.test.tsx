/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, fireEvent, waitFor, within } from "@testing-library/react";

// Reactive next/navigation mock (mirrors src/components/__tests__/StatusFilter.test.tsx):
// router.replace writes back into `search` so a `rerender()` after a click picks up
// the new useSearchParams() value, same as a real app-router navigation would.
let search = "";
const replace = jest.fn((url: string) => {
    search = url.split("?")[1] ?? "";
});
jest.mock("next/navigation", () => ({
    useRouter: () => ({ replace }),
    usePathname: () => "/membership-ops/applications",
    useSearchParams: () => new URLSearchParams(search),
}));
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { EnvProvider } from "@/components/EnvProvider";
import { renderWithProviders, mockFetchJson, resetRtl, setSession } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import { settleAfter } from "@/test-helpers/settle";
import AdminMembershipPage from "../page";

// A missing reason shows on the field, with focus on it, and raises no lower-right message.
const expectReasonFlagged = (dialog: HTMLElement, message: string) => {
    const field = within(dialog).getByRole("textbox", { name: /Reason/ });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(notifications.show).not.toHaveBeenCalledWith(expect.objectContaining({ message }));
};
// modals.open is a no-op without a provider, so a confirmed action would
// silently never fire. Wrapped here rather than in the shared harness: several suites
// jest.mock("@mantine/modals") and would get an undefined ModalsProvider.
const renderPage = () => renderWithProviders(<ModalsProvider><AdminMembershipPage /></ModalsProvider>);

// rerender() replaces the whole root, so re-supplying it must mirror renderPage's
// wrapper tree (same component types at each level) or React remounts instead of
// reconciling, losing the page's already-fetched rows state.
const rewrapped = () => (
    <MantineProvider>
        <EnvProvider value={{ checkinEnv: "prod", shopifyStoreDomain: null, isStaging: false, devMocks: { shopify: false, bgConsent: false } }}>
            <ModalsProvider>
                <AdminMembershipPage />
            </ModalsProvider>
        </EnvProvider>
    </MantineProvider>
);

beforeEach(() => {
    resetRtl();
    (notifications.show as jest.Mock).mockClear();
    search = "";
    replace.mockClear();
});

function household(name: string, id: number) {
    return { name, householdMembers: [{ id: 1, name: "Lead One", email: "lead@example.com", isHouseholdLead: true }], householdId: id };
}

const archivedRows = [
    {
        id: 4,
        kind: "NEW",
        status: "ARCHIVED",
        createdAt: "2026-01-01T00:00:00.000Z",
        zohoEnvelopeId: null,
        contractSignedAt: null,
        bgConsentAt: null,
        bgClearedAt: null,
        paidAt: null,
        attestations: [],
        orgMembership: { householdId: 4, isVolunteerFamily: false, household: household("Archived Family", 4) },
    },
];

const rows = [
    {
        id: 1,
        kind: "NEW",
        status: "PENDING_EXTERNAL_ACTION",
        createdAt: "2026-01-01T00:00:00.000Z",
        zohoEnvelopeId: null,
        contractSignedAt: null,
        bgConsentAt: null,
        bgClearedAt: null,
        paidAt: null,
        attestations: [],
        orgMembership: { householdId: 1, isVolunteerFamily: false, household: household("Awaiting Family", 1) },
    },
    {
        id: 2,
        kind: "RENEWAL",
        status: "PENDING_PAYMENT",
        createdAt: "2026-01-01T00:00:00.000Z",
        zohoEnvelopeId: "env-1",
        contractSignedAt: "2026-01-02T00:00:00.000Z",
        bgConsentAt: "2026-01-02T00:00:00.000Z",
        bgClearedAt: null,
        paidAt: null,
        attestations: [],
        orgMembership: { householdId: 2, isVolunteerFamily: true, household: household("Payment Family", 2) },
    },

    {
        id: 3,
        kind: "NEW",
        status: "BLOCKED",
        createdAt: "2026-01-01T00:00:00.000Z",
        zohoEnvelopeId: "env-3",
        contractSignedAt: "2026-01-02T00:00:00.000Z",
        bgConsentAt: "2026-01-02T00:00:00.000Z",
        bgClearedAt: null,
        paidAt: "2026-01-03T00:00:00.000Z",
        attestations: [],
        orgMembership: { householdId: 3, isVolunteerFamily: false, household: household("Blocked Family", 3) },
    },
];

// A check review a household asked for, named and holding one approval.
const reviewRow = {
    id: 5,
    kind: "PERSON_BG",
    status: "PENDING_BG_REVIEW",
    createdAt: "2026-01-01T00:00:00.000Z",
    zohoEnvelopeId: null,
    contractSignedAt: null,
    bgConsentAt: "2026-01-02T00:00:00.000Z",
    bgClearedAt: null,
    paidAt: null,
    attestations: [{ id: 1, result: "APPROVE", subjectPersonId: 21, isMarkedVolunteerFamily: false }],
    requestedForHouseholdId: 2,
    subjectPerson: { id: 21, name: "Robin Payment", householdId: 2 },
    orgMembership: null,
};

describe("AdminMembershipPage", () => {
    it("renders in-flight applications and their status counts", async () => {
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();

        expect(await screen.findByText("Awaiting Family")).toBeInTheDocument();
        expect(screen.getByText("Payment Family")).toBeInTheDocument();
        expect(screen.getByText("Blocked Family")).toBeInTheDocument();
        expect(screen.getByText(/1 application\(s\) blocked/)).toBeInTheDocument();
        expect(screen.getByText(/This household already paid/)).toBeInTheDocument();
    });

    it("names a per-person process for its subject person, with a readable kind", async () => {
        const perPerson = (id: number, kind: string, name: string) => ({
            ...rows[0], id, kind, orgMembership: null, subjectPerson: { id: 100 + id, name },
        });
        mockFetchJson({
            "/api/membership-ops/applications": {
                processes: [
                    perPerson(11, "PERSON_AGREEMENT", "Adult Child"),
                    perPerson(12, "PERSON_BG", "Checked Volunteer"),
                    perPerson(13, "KEY_VOLUNTEER_AGREEMENT", "Key Volunteer"),
                ],
            },
        });
        renderPage();

        expect(await screen.findByText("Adult Child")).toBeInTheDocument();
        expect(screen.getByText("Checked Volunteer")).toBeInTheDocument();
        expect(screen.getByText("Key Volunteer")).toBeInTheDocument();
        expect(screen.getByText(/Membership agreement · application #11/)).toBeInTheDocument();
        expect(screen.getByText(/Background check · application #12/)).toBeInTheDocument();
        expect(screen.getByText(/Key Volunteer agreement · application #13/)).toBeInTheDocument();
        expect(screen.queryByText(/Household #/)).not.toBeInTheDocument();
    });

    it("shows an empty state when there are no in-flight applications", async () => {
        mockFetchJson({ "/api/membership-ops/applications": { processes: [] } });
        renderPage();
        expect(await screen.findByText("No in-flight membership applications.")).toBeInTheDocument();
    });

    it("offers certify-payment only to the board, not a sysadmin", async () => {
        setSession({ id: 99, householdId: 99, isSysadmin: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();
        await screen.findByText("Payment Family");
        expect(screen.queryByRole("button", { name: /Activate without payment/ })).not.toBeInTheDocument();
    });

    it("offers no review reset or override to a sysadmin off the board", async () => {
        setSession({ id: 99, householdId: 99, isSysadmin: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();
        await screen.findByText("Blocked Family");
        expect(screen.queryByRole("button", { name: "Discard approvals — start the review over" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Reset for re-review" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Override →/ })).not.toBeInTheDocument();
        expect(screen.getByText("A board member can reset this review.")).toBeInTheDocument();
    });

    it("flags the Lead field when a two-lead household's check is marked started with no lead picked", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const twoLeads = {
            ...rows[0],
            orgMembership: {
                ...rows[0].orgMembership,
                household: {
                    ...household("Awaiting Family", 1),
                    householdMembers: [
                        { id: 1, name: "Lead One", email: "lead@example.com", isHouseholdLead: true },
                        { id: 2, name: "Lead Two", email: "lead2@example.com", isHouseholdLead: true },
                    ],
                },
            },
        };
        const fetchMock = mockFetchJson({ "/api/membership-ops/applications": { processes: [twoLeads] } });
        renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByRole("button", { name: "Mark a lead's check started" }));
        const dialog = await screen.findByRole("dialog", { name: "Mark a lead's check started" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Mark check started" }));

        const lead = within(dialog).getByRole("textbox", { name: /Lead/ });
        expect(lead).toHaveAttribute("aria-invalid", "true");
        expect(lead).toHaveFocus();
        expect(within(dialog).getByText("Pick a lead.")).toBeInTheDocument();
        expect(notifications.show).not.toHaveBeenCalledWith(expect.objectContaining({ message: "Pick a lead." }));
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("person-bg"))).toBe(false);
    });

    it("drives the external-action, certify, and reset controls", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        mockFetchJson({
            "/api/membership-ops/applications": { processes: rows },
            "/api/membership-ops/applications/external": { ok: true },
            "/api/membership-ops/applications/certify-payment": { ok: true },
            "/api/membership-ops/applications/review-override": { ok: true },
            "/api/membership-audit/person-bg": { process: { id: 9 } },
        });
        renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByRole("button", { name: "Confirm contract signed" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Updated." })));

        expect(screen.queryByRole("button", { name: "Confirm BG consent" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Mark a lead's check started" }));
        const markDialog = await screen.findByRole("dialog", { name: "Mark a lead's check started" });
        fireEvent.click(within(markDialog).getByRole("button", { name: "Mark check started" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Check marked started." })));

        fireEvent.click(screen.getByRole("button", { name: /Activate without payment/ }));
        // Mantine's `required` prop appends a visible " *" to the label text.
        const certifyReasonInput = await screen.findByLabelText(/^Reason/);
        // The confirm button is disabled until a reason is entered.
        expect(screen.getByRole("button", { name: "Certify" })).toBeDisabled();
        fireEvent.change(certifyReasonInput, { target: { value: "Paid by check outside Shopify" } });
        fireEvent.click(screen.getByRole("button", { name: "Certify" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Certified — membership activated." })));

        fireEvent.click(screen.getByRole("button", { name: "Reset for re-review" }));
        const dialog = await screen.findByRole("dialog", { name: "Start this background-check review over?" });
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "reviewed the wrong report" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Sent back for re-review." })));

        // Board ruling B5/B25: the board resets a blocked review but never clears it.
        expect(screen.queryByRole("button", { name: /Override/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    });

    it("shows a refused row action in the lower right, and re-reads the board on a 409", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
        const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/external")) return answer(400, { error: "The contract is already signed." });
            if (url.includes("/certify-payment")) return answer(409, { error: "This application is no longer awaiting payment.", code: "wrong_phase" });
            return answer(200, { processes: rows });
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        const boardReads = () => fetchMock.mock.calls.filter(([url]) => String(url) === "/api/membership-ops/applications").length;
        renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByRole("button", { name: "Confirm contract signed" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", title: "Awaiting Family", message: "The contract is already signed.", autoClose: false })));
        expect(screen.queryByText("The contract is already signed.")).not.toBeInTheDocument();

        const readsBefore = boardReads();
        fireEvent.click(screen.getByRole("button", { name: /Activate without payment/ }));
        fireEvent.change(await screen.findByLabelText(/^Reason/), { target: { value: "Paid by check" } });
        fireEvent.click(screen.getByRole("button", { name: "Certify" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "This application is no longer awaiting payment." })));
        await waitFor(() => expect(boardReads()).toBe(readsBefore + 1));
    });

    it("keeps the certify button disabled while the certify is in flight", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        let release: (res: Response) => void = () => {};
        const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
        const fetchMock = jest.fn((input: RequestInfo | URL) =>
            String(input).includes("/certify-payment")
                ? new Promise<Response>((resolve) => { release = resolve; })
                : Promise.resolve(answer({ processes: rows })));
        global.fetch = fetchMock as unknown as typeof fetch;
        const certifies = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/certify-payment")).length;
        renderPage();
        await screen.findByText("Payment Family");

        fireEvent.click(screen.getByRole("button", { name: /Activate without payment/ }));
        fireEvent.change(await screen.findByLabelText(/^Reason/), { target: { value: "Paid by check" } });
        fireEvent.click(screen.getByRole("button", { name: "Certify" }));
        await waitFor(() => expect(certifies()).toBe(1));
        const rowButton = screen.getByRole("button", { name: /Activate without payment/ });
        expect(rowButton).toBeDisabled();
        fireEvent.click(rowButton);
        expect(certifies()).toBe(1);

        release(answer({ ok: true }));
        await waitFor(() => expect(screen.getByRole("button", { name: /Activate without payment/ })).toBeEnabled());
    });

    const startedReview = (personId: number) => ({
        ...reviewRow, id: 7, attestations: [], requestedForHouseholdId: 1, subjectPerson: { id: personId, name: `Person ${personId}`, householdId: 1 },
    });

    it("derives a household's check started from a lead's open review", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: [rows[0], startedReview(1)] } });
        renderPage();
        await screen.findByText("Awaiting Family");
        expect(screen.getByText("✓ Started")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Mark a lead's check started" })).not.toBeInTheDocument();
    });

    it("does not count another adult's started check for the household", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: [rows[0], startedReview(50)] } });
        renderPage();
        await screen.findByText("Awaiting Family");
        expect(screen.getByRole("button", { name: "Mark a lead's check started" })).toBeInTheDocument();
        expect(screen.queryByText("✓ Started")).not.toBeInTheDocument();
    });

    it("lets a Board member dismiss a check review with no decisions, with a reason", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fresh = { ...reviewRow, id: 8, attestations: [] };
        const fetchMock = mockFetchJson({
            "/api/membership-ops/applications": { processes: [fresh, reviewRow] },
            "/api/membership/reviews/dismiss": {},
        });
        renderPage();
        await screen.findAllByText("Robin Payment");

        // Only the review with no decision on it offers the dismissal.
        expect(screen.getAllByRole("button", { name: "Dismiss: opened by mistake" })).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Dismiss: opened by mistake" }));
        const dialog = await screen.findByRole("dialog", { name: "Dismiss: opened by mistake" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
        expectReasonFlagged(dialog, "A reason is required to dismiss a check review.");
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("reviews/dismiss"))).toBe(false);
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "never took the check" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/membership/reviews/dismiss",
                expect.objectContaining({ body: JSON.stringify({ processId: 8, reason: "never took the check" }) }),
            ),
        );
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Dismissed: the check is no longer marked started." })));
    });

    it("offers no dismissal to a sysadmin off the board", async () => {
        setSession({ id: 99, householdId: 99, isSysadmin: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: [{ ...reviewRow, attestations: [] }] } });
        renderPage();
        await screen.findByText("Robin Payment");
        expect(screen.queryByRole("button", { name: "Dismiss: opened by mistake" })).not.toBeInTheDocument();
    });

    it("shows a household application waiting on its check review", async () => {
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();
        await screen.findByText("Payment Family");
        expect(screen.getByText(/waiting on the household's check review/)).toBeInTheDocument();
    });

    it("clears a still-open check review's approvals, with a reason, as the wrong person", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = mockFetchJson({
            "/api/membership-ops/applications": { processes: [...rows, reviewRow] },
            "/api/membership-ops/applications/review-override": { ok: true },
        });
        renderPage();
        await screen.findByText("Payment Family");

        // Only the check review with an approval on it offers the reset.
        const reset = screen.getByRole("button", { name: "Discard approvals — start the review over" });
        fireEvent.click(reset);
        expect(await screen.findByText("Start this background-check review over?")).toBeInTheDocument();
        const dialog = screen.getByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
        expectReasonFlagged(dialog, "A reason is required to start a review over.");
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("review-override"))).toBe(false);
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "names the wrong parent" } });
        fireEvent.click(within(dialog).getByRole("switch", { name: /names the wrong person/ }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/membership-ops/applications/review-override",
                expect.objectContaining({ body: JSON.stringify({ processId: 5, action: "reset", reason: "names the wrong parent", wrongPerson: true }) }),
            ),
        );
    });

    it.each([
        ["an open", reviewRow],
        ["a blocked", { ...reviewRow, status: "BLOCKED", attestations: [{ id: 2, result: "REJECT", subjectPersonId: 21, isMarkedVolunteerFamily: false }] }],
    ])("closes %s check review as opened for the wrong person, with a reason", async (_label, review) => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = mockFetchJson({
            "/api/membership-ops/applications/review-override": { outcome: { status: "ARCHIVED" } },
            "/api/membership-ops/applications": { processes: [review] },
        });
        renderPage();
        await screen.findByText("Robin Payment");

        fireEvent.click(screen.getByRole("button", { name: "Close: opened for the wrong person" }));
        const dialog = await screen.findByRole("dialog", { name: "Close this check review as opened for the wrong person?" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Close review" }));
        expectReasonFlagged(dialog, "A reason is required to close a review as opened for the wrong person.");
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("review-override"))).toBe(false);
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: " another person's report " } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Close review" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/membership-ops/applications/review-override",
                expect.objectContaining({ body: JSON.stringify({ processId: 5, action: "reset", reason: "another person's report", closeAsWrongPerson: true }) }),
            ),
        );
    });

    it("offers the wrong-person close to the Board only", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: false, isBackgroundCheckReviewer: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: [reviewRow] } });
        renderPage();
        await screen.findByText("Robin Payment");
        expect(screen.queryByRole("button", { name: "Close: opened for the wrong person" })).not.toBeInTheDocument();
    });

    it("reopens a closed check review, with a reason, from the closed list", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = mockFetchJson({
            "/api/membership-ops/applications/review-override": { outcome: { status: "BLOCKED" } },
            "/api/membership-ops/applications?archived=1": { processes: [{ ...reviewRow, status: "ARCHIVED" }] },
            "/api/membership-ops/applications": { processes: rows },
        });
        renderPage();
        await screen.findByText("Awaiting Family");
        fireEvent.click(screen.getByLabelText("Show closed applications"));
        await screen.findByText("Robin Payment");

        fireEvent.click(screen.getByRole("button", { name: "Reopen: closed as wrong person" }));
        const dialog = await screen.findByRole("dialog", { name: "Reopen this check review?" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Reopen review" }));
        expectReasonFlagged(dialog, "A reason is required to reopen a review.");
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "it was them after all" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Reopen review" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/membership-ops/applications/review-override",
                expect.objectContaining({ body: JSON.stringify({ processId: 5, action: "reopen", reason: "it was them after all" }) }),
            ),
        );
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Check review reopened." })));
    });

    it("releases a blocked household whose rejected person has left, with a reason", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = mockFetchJson({
            "/api/membership-ops/applications": { processes: rows },
            "/api/membership-ops/applications/review-override": { ok: true },
        });
        renderPage();
        await screen.findByText("Blocked Family");

        fireEvent.click(screen.getByRole("button", { name: "Release" }));
        const dialog = await screen.findByRole("dialog", { name: "Release this household from a departed person's rejection?" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Release" }));
        expectReasonFlagged(dialog, "A reason is required to release a household.");
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("review-override"))).toBe(false);
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: " divorced, moved out " } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Release" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/membership-ops/applications/review-override",
                expect.objectContaining({ body: JSON.stringify({ processId: 3, action: "release", reason: "divorced, moved out" }) }),
            ),
        );
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Released — the application moves on." })));
    });

    it("offers no release while someone in the blocked household is under a rejected check review", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const rejected = { ...reviewRow, id: 6, status: "BLOCKED", requestedForHouseholdId: 3, subjectPerson: { id: 31, name: "Sam Blocked", householdId: 3 } };
        mockFetchJson({ "/api/membership-ops/applications": { processes: [...rows, rejected] } });
        renderPage();
        await screen.findByText("Blocked Family");
        expect(screen.getAllByRole("button", { name: "Reset for re-review" }).length).toBeGreaterThan(0);
        expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    });

    it("disables release for the actor's own household", async () => {
        setSession({ id: 99, householdId: 3, isBoardMember: true });
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();
        await screen.findByText("Blocked Family");
        expect(screen.getByRole("button", { name: "Release" })).toBeDisabled();
    });

    it("clicking a legend badge narrows the list to that status; clicking again restores it", async () => {
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        const { rerender } = renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByRole("button", { name: "PENDING PAYMENT: 1" }));
        rerender(rewrapped());

        expect(screen.queryByText("Awaiting Family")).not.toBeInTheDocument();
        expect(screen.queryByText("Blocked Family")).not.toBeInTheDocument();
        expect(screen.getByText("Payment Family")).toBeInTheDocument();
        expect(screen.getByText(/Showing only/)).toBeInTheDocument();
        // counts stay computed from all rows while filtered
        expect(screen.getByText("PENDING EXTERNAL ACTION: 1")).toBeInTheDocument();
        expect(screen.getByText("BLOCKED: 1")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "PENDING PAYMENT: 1" }));
        rerender(rewrapped());

        expect(screen.getByText("Awaiting Family")).toBeInTheDocument();
        expect(screen.getByText("Blocked Family")).toBeInTheDocument();
        expect(screen.getByText("Payment Family")).toBeInTheDocument();
        expect(screen.queryByText(/Showing only/)).not.toBeInTheDocument();
    });

    it("tags a renewal whose household said it won't renew, and filters to the tagged ones", async () => {
        const declined = {
            ...rows[1],
            id: 7,
            status: "PENDING_RENEWAL",
            paidAt: null,
            notRenewing: true,
            orgMembership: { householdId: 7, isVolunteerFamily: false, household: household("Leaving Family", 7) },
        };
        const waiting = { ...declined, id: 8, notRenewing: false, orgMembership: { householdId: 8, isVolunteerFamily: false, household: household("Slow Family", 8) } };
        mockFetchJson({ "/api/membership-ops/applications": { processes: [...rows, declined, waiting] } });
        const { rerender } = renderPage();
        await screen.findByText("Leaving Family");

        expect(screen.getAllByRole("button", { name: "Not renewing" })).toHaveLength(1);
        expect(screen.getByText("PENDING RENEWAL: 2")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Not renewing: 1" }));
        rerender(rewrapped());

        expect(screen.getByText("Leaving Family")).toBeInTheDocument();
        expect(screen.queryByText("Slow Family")).not.toBeInTheDocument();
        expect(screen.queryByText("Awaiting Family")).not.toBeInTheDocument();
        expect(screen.getByText(/Showing only/)).toHaveTextContent("Showing only Not renewing");
    });

    it("shows a clear-filter empty state when the active status has no matching rows", async () => {
        search = "status=PENDING_BG_REVIEW";
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();

        expect(await screen.findByText(/No applications in PENDING BG REVIEW/)).toBeInTheDocument();
        expect(screen.queryByText("Awaiting Family")).not.toBeInTheDocument();

        // Two "Clear filter" actions are visible here: the ActiveFilterNotice and the
        // empty-state card's own clear button. Either should reset the same param.
        fireEvent.click(screen.getAllByRole("button", { name: "Clear filter" })[0]);
        await waitFor(() => expect(replace).toHaveBeenCalledWith("/membership-ops/applications", { scroll: false }));
    });

    it("shows closed applications behind the toggle, with Reopen as the only action", async () => {
        mockFetchJson({
            // More specific keys first: mockFetchJson matches by substring, and
            // "/applications" is a substring of both the closed-list query and the
            // reopen action URL.
            "/api/membership-ops/applications/unarchive": { outcome: { status: "PENDING_PAYMENT" } },
            "/api/membership-ops/applications?archived=1": { processes: archivedRows },
            "/api/membership-ops/applications": { processes: rows },
        });
        renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByLabelText("Show closed applications"));
        expect(await screen.findByText("Archived Family")).toBeInTheDocument();
        expect(screen.queryByText("Awaiting Family")).not.toBeInTheDocument();

        // Status-filter badges don't apply to the closed view, and Reopen is the
        // only action offered — no close/certify/override/refund controls.
        expect(screen.queryByRole("button", { name: /PENDING PAYMENT:/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Close application" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Record refund" })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Application reopened." })));
    });

    it("disables Reopen on a closed application whose year the next renewal window has superseded", async () => {
        mockFetchJson({
            "/api/settings/membership": { settings: { BoardSettings: { orgMembershipYearBoundary: "2020-08-01T00:00:00.000Z" } } },
            "/api/membership-ops/applications?archived=1": { processes: [{ ...archivedRows[0], kind: "INITIAL", createdAt: "2020-03-01T00:00:00.000Z" }] },
            "/api/membership-ops/applications": { processes: rows },
        });
        renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByLabelText("Show closed applications"));
        expect(await screen.findByText(/This application is for 2019-2020\. The 2020-2021 renewal period has started/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reopen" })).toBeDisabled();
    });

    it("never shows the word archive for an application", async () => {
        mockFetchJson({ "/api/membership-ops/applications": { processes: rows } });
        renderPage();
        await screen.findByText("Awaiting Family");
        expect(document.body.textContent ?? "").not.toMatch(/archiv/i);
    });

    it("offers Close only on unpaid applications and Record refund only on paid ones", async () => {
        mockFetchJson({
            "/api/membership-ops/applications/refund": { process: { id: 3, status: "BLOCKED" } },
            "/api/membership-ops/applications": { processes: rows },
        });
        renderPage();
        await screen.findByText("Awaiting Family");

        // Awaiting + Payment are unpaid; the paid BLOCKED row can't be closed.
        expect(screen.getAllByRole("button", { name: "Close application" })).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: "Record refund" })).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: "Record refund" }));
        fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: "Refunded in Shopify" } });
        const confirm = screen.getAllByRole("button", { name: "Record refund" }).at(-1)!;
        fireEvent.click(confirm);

        await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
            "/api/membership-ops/applications/refund",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ processId: 3, reason: "Refunded in Shopify" }) }),
        ));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Refund recorded." })));
    });
});

describe("failed load", () => {
    it("shows an error with a retry, never the empty state", async () => {
        setSession({ id: 1 });
        mockFetchJson({});
        renderPage();

        await settleAfter("/api/membership-ops/applications");
        expect(screen.queryByText("No in-flight membership applications.")).not.toBeInTheDocument();
        expect(await screen.findByText("Couldn't load applications")).toBeInTheDocument();

        mockFetchJson({ "/api/membership-ops/applications": { processes: [] } });
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText("No in-flight membership applications.")).toBeInTheDocument();
    });
});

describe("Reset for re-review while the reload is in flight", () => {
    it("sends no second request on a second click", async () => {
        setSession({ id: 1, isBoardMember: true });
        const blocked = { ...archivedRows[0], id: 7, status: "BLOCKED", orgMembership: null, subjectPerson: { id: 9, name: "Pat" }, attestations: [] };
        let finishReload: (rows: unknown) => void = () => {};
        let reads = 0;
        const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
            if (init?.method === "POST") return answer({});
            reads += 1;
            if (reads === 1) return answer({ processes: [blocked] });
            return new Promise<Response>((resolve) => { finishReload = (rows) => resolve(answer({ processes: rows })); });
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        renderPage();

        const reset = await screen.findByRole("button", { name: "Reset for re-review" });
        fireEvent.click(reset);
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: "start over" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Sent back for re-review." })));
        await waitFor(() => expect(reads).toBe(2));

        fireEvent.click(screen.getByRole("button", { name: "Reset for re-review" }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

        finishReload([{ ...blocked, status: "PENDING_BG_REVIEW" }]);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Reset for re-review" })).not.toBeInTheDocument());
    });
});

describe("Fix pending background checks", () => {
    const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
    const serve = (settle: () => Response) => {
        const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            void init;
            return String(input).includes("/settle-waiting") ? settle() : answer(200, { processes: rows });
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        return fetchMock;
    };
    const settleCalls = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter(([url]) => String(url).includes("/settle-waiting"));

    it("is offered to the board only", async () => {
        setSession({ id: 99, householdId: 99, isSysadmin: true });
        serve(() => answer(200, {}));
        renderPage();
        await screen.findByText("Awaiting Family");
        expect(screen.queryByRole("button", { name: "Fix pending background checks" })).not.toBeInTheDocument();
    });

    it("asks first, and a cancel sends nothing", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = serve(() => answer(200, { households: 0, opened: 0, failed: 0 }));
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: "Fix pending background checks" }));
        expect(await screen.findByText("Re-check every application waiting on a background check?")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByText("Re-check every application waiting on a background check?")).not.toBeInTheDocument());
        expect(settleCalls(fetchMock)).toHaveLength(0);
    });

    it("shows the counts after a confirm", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = serve(() => answer(200, { households: 7, opened: 7, failed: 0 }));
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: "Fix pending background checks" }));
        fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "green", message: "Re-checked 7 household(s); 7 moved on." })));
        expect(settleCalls(fetchMock)).toHaveLength(1);
        expect(settleCalls(fetchMock)[0][1]).toMatchObject({ method: "POST" });
    });

    it("names failed households and points at System Status, in a message that stays", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        serve(() => answer(200, { households: 7, opened: 5, failed: 2 }));
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: "Fix pending background checks" }));
        fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
            color: "yellow",
            message: "Re-checked 7 household(s); 5 moved on. 2 failed: see System Status.",
            autoClose: false,
        })));
    });

    it("shows the server's refusal in a red chip that does not close itself", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        serve(() => answer(403, { error: "Forbidden" }));
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: "Fix pending background checks" }));
        fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
            color: "red",
            title: "Fix pending background checks",
            message: "Forbidden",
            autoClose: false,
        })));
    });
});
