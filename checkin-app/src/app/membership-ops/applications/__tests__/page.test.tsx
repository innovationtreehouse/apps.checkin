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
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { EnvProvider } from "@/components/EnvProvider";
import { renderWithProviders, mockFetchJson, resetRtl, setSession } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import AdminMembershipPage from "../page";

// modals.openConfirmModal is a no-op without a provider, so a confirmed action would
// silently never fire. Wrapped here rather than in the shared harness: several suites
// jest.mock("@mantine/modals") and would get an undefined ModalsProvider.
const renderPage = () => renderWithProviders(<ModalsProvider><AdminMembershipPage /></ModalsProvider>);

// rerender() replaces the whole root, so re-supplying it must mirror renderPage's
// wrapper tree (same component types at each level) or React remounts instead of
// reconciling, losing the page's already-fetched rows state.
const rewrapped = () => (
    <MantineProvider>
        <EnvProvider value={{ checkinEnv: "prod", shopifyStoreDomain: null, isStaging: false }}>
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
        attestations: [{ id: 1, result: "APPROVE", isMarkedVolunteerFamily: false }],
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
        expect(screen.queryByRole("button", { name: /Certify payment plan/ })).not.toBeInTheDocument();
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

    it("drives the external-action, certify, and reset controls", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        mockFetchJson({
            "/api/membership-ops/applications": { processes: rows },
            "/api/membership-ops/applications/external": { ok: true },
            "/api/membership-ops/applications/certify-payment": { ok: true },
            "/api/membership-ops/applications/review-override": { ok: true },
        });
        renderPage();
        await screen.findByText("Awaiting Family");

        fireEvent.click(screen.getByRole("button", { name: "Confirm contract signed" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Updated." })));

        fireEvent.click(screen.getByRole("button", { name: "Confirm BG consent" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Updated." })));

        fireEvent.click(screen.getByRole("button", { name: /Certify payment plan/ }));
        // Mantine's `required` prop appends a visible " *" to the label text.
        const certifyReasonInput = await screen.findByLabelText(/^Reason/);
        // The confirm button is disabled until a reason is entered.
        expect(screen.getByRole("button", { name: "Certify" })).toBeDisabled();
        fireEvent.change(certifyReasonInput, { target: { value: "Paid by check outside Shopify" } });
        fireEvent.click(screen.getByRole("button", { name: "Certify" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Certified — membership activated." })));

        fireEvent.click(screen.getByRole("button", { name: "Reset for re-review" }));
        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Sent back for re-review." })));

        // Board ruling B5/B25: the board resets a blocked review but never clears it.
        expect(screen.queryByRole("button", { name: /Override/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    });

    it("clears a still-open review's approvals, behind a confirmation", async () => {
        setSession({ id: 99, householdId: 99, isBoardMember: true });
        const fetchMock = mockFetchJson({
            "/api/membership-ops/applications": { processes: rows },
            "/api/membership-ops/applications/review-override": { ok: true },
        });
        renderPage();
        await screen.findByText("Payment Family");

        // Only the in-review row with an approval on it offers the reset.
        const reset = screen.getByRole("button", { name: "Discard approvals — start the review over" });
        fireEvent.click(reset);
        expect(await screen.findByText("Start this background-check review over?")).toBeInTheDocument();
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard approvals" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/membership-ops/applications/review-override",
                expect.objectContaining({ body: JSON.stringify({ processId: 2, action: "reset" }) }),
            ),
        );
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
