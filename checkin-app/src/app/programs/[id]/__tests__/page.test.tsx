/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, waitFor, fireEvent } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));
import { notifications } from "@mantine/notifications";
import { signIn } from "next-auth/react";
import { renderWithProviders, mockFetchJson, setSession, setShopifyStoreDomain, router, resetRtl } from "@/test-helpers/rtl";
import ProgramEnrollmentPage from "../page";

beforeEach(() => {
    resetRtl();
    (notifications.show as jest.Mock).mockClear();
    (signIn as jest.Mock).mockClear();
});

// `use(params)` suspends on any promise it hasn't already tracked, even one that
// resolved microtasks ago — pre-mark it "fulfilled" (React's own thenable-caching
// shape) so `use` returns synchronously and the page doesn't need a Suspense
// boundary/act(async) dance in every test.
function paramsFor(id: string): Promise<{ id: string }> {
    const p = Promise.resolve({ id }) as Promise<{ id: string }> & { status?: string; value?: unknown };
    p.status = "fulfilled";
    p.value = { id };
    return p;
}

const params = paramsFor("10");

/** A failed action waits in the lower right until dismissed. */
function errorShown(message: string | RegExp) {
    return waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
        color: "red", autoClose: false, message: typeof message === "string" ? message : expect.stringMatching(message),
    })));
}

function errorNotShown(message: RegExp) {
    expect(notifications.show).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(message) }));
}

function res(body: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function renderPage() {
    return renderWithProviders(<ProgramEnrollmentPage params={params} />);
}

// Nobody is ever pre-checked, so every enrolling test picks its participants the
// way a household does. A click toggles, so a second call unchecks. findByLabelText
// waits out the in-flight household fetch.
async function toggleMember(name: string) {
    fireEvent.click(await screen.findByLabelText(name));
}

/** Open the request modal, state which ask it is, send. The kind is required, so
 *  "Send request" stays disabled until one is picked. */
async function requestPlan(kind: RegExp = /^Payment plan$/) {
    fireEvent.click(screen.getByRole("button", { name: /request a scholarship or payment plan/i }));
    fireEvent.click(await screen.findByRole("radio", { name: kind }));
    fireEvent.click(screen.getByRole("button", { name: /^Send request$/ }));
}

// The intake state the emergency-contact probe reads: a valid contact on file.
const intakeWithContact = { hasEmergencyContact: true };

const household = {
    household: {
        householdMembers: [
            { id: 100, name: "Jamie Guardian", dateOfBirth: "1990-01-01" },
            { id: 101, name: "Kid One", dateOfBirth: "2015-01-01" },
            { id: 102, name: "Too Young", dateOfBirth: "2023-01-01" },
        ],
    },
};

function baseProgram(overrides: Record<string, unknown> = {}) {
    return {
        id: 10,
        name: "Robotics Club",
        startAt: "2026-06-01T00:00:00.000Z",
        endAt: "2026-12-31T00:00:00.000Z",
        enrollmentClosedBy: null,
        leadMentorId: 5,
        leadMentor: { name: "Coach K", email: "coach@example.com" },
        participants: [{ personId: 100, status: "ACTIVE" }],
        enrollmentStatus: "OPEN",
        orgMemberPriceCents: null,
        nonOrgMemberPriceCents: null,
        shopifyVariantId: null,
        minAge: 5,
        maxAge: 18,
        ...overrides,
    };
}

describe("ProgramEnrollmentPage", () => {
    it("free program: a lead enrolls a household member", async () => {
        setSession({ id: 100, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10/participants": { ok: true },
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram(),
        });
        renderPage();

        expect(await screen.findByText("Robotics Club")).toBeInTheDocument();
        expect(screen.getByText("Coach K")).toBeInTheDocument();
        expect(screen.getByText("Open")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByText("Which of your household wants to enroll?")).toBeInTheDocument();
        expect(screen.getByText("(Enrolled)")).toBeInTheDocument();
        expect(screen.getByText("(Too young)")).toBeInTheDocument();

        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Successfully enrolled!" })),
        );
    });

    // A youth is shown no payment obligation, action, or status — their own or
    // their household's. The refusal is an absence, not a door that won't open:
    // the CTA names who may act and never mentions money, on free and paid alike.
    it("shows a youth the lead-required CTA and no payment surface", async () => {
        setSession({ id: 101, ageBand: 'youth' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
                orgMemberPriceCents: 5000, minAge: null, maxAge: null,
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        const cta = screen.getByRole("button", { name: "A household lead must enroll you" });
        expect(cta).toBeDisabled();
        // Never the payment-pending wording, and never the resume affordance.
        expect(screen.queryByRole("button", { name: "Continue enrollment" })).not.toBeInTheDocument();
        expect(screen.queryByText(/not paid|payment pending/i)).not.toBeInTheDocument();
        expect(screen.queryByText("Already enrolled from your household:")).not.toBeInTheDocument();
        // Price stays public — it is program information, not a payment situation.
        expect(screen.getByText("$50.00")).toBeInTheDocument();
    });

    // The same household seen by an adult still offers the checkout, so the
    // assertions above are about the viewer's age and not a broken fixture.
    it("still shows the payment-pending resume to an adult in the same household", async () => {
        // householdId is what links the pending row to the viewer in myEnrolled.
        setSession({ id: 100, ageBand: 'adult', householdId: 7 });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
                orgMemberPriceCents: 5000, minAge: null, maxAge: null,
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Continue enrollment" })).toBeEnabled();
        expect(screen.getByText("Already enrolled from your household:")).toBeInTheDocument();
    });

    // An unknown age is asked for a date of birth before any payment surface:
    // no payment status, no resume, no pay or scholarship action, and never a
    // lead they may not have.
    it("asks a viewer of unknown age for a date of birth instead of showing payment", async () => {
        setSession({ id: 300, ageBand: 'unknown', householdId: 7 });
        mockFetchJson({
            "/api/household/intake": intakeWithContact,
            "/api/household": { household: { householdMembers: [{ id: 300, name: "New Adult", dateOfBirth: null }, { id: 101, name: "Kid One", dateOfBirth: "2015-01-01" }] } },
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
                orgMemberPriceCents: 5000, minAge: null, maxAge: null,
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.queryByRole("button", { name: "Continue enrollment" })).not.toBeInTheDocument();
        expect(screen.queryByText(/not paid/i)).not.toBeInTheDocument();
        expect(screen.queryByText("Already enrolled from your household:")).not.toBeInTheDocument();
        expect(screen.queryByText("A household lead must enroll you")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Add your date of birth to continue" }));
        await screen.findByText("Finish setting up your household");
        expect(screen.getByLabelText("I am over 25")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Pay on Shopify" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /request a scholarship or payment plan/i })).not.toBeInTheDocument();
    });

    it("first-time user finishes household setup, then enrolls a child (auth-first)", async () => {
        setSession({ id: 500, ageBand: 'unknown' });
        let childAdded = false;
        const adult = { id: 500, name: "New Parent", dateOfBirth: null };
        const child = { id: 501, name: "New Kid", dateOfBirth: "2015-01-01" };
        // Process-free intake state; the POST mutates it (child + emergency
        // contact now saved) so the subsequent EC probe reads them back.
        const intakeState = {
            hasEmergencyContact: false,
            prefill: {
                household: { emergencyContactName: null, emergencyContactPhone: null, emergencyContactEmail: null, line1: null },
                primaryParent: { id: 500, name: "New Parent", email: null, dob: null, over25: false, allergies: null },
                secondaryParent: null,
                children: [] as unknown[],
            },
        };
        const json = (b: unknown) => res(b, 200);
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            // Order matters: /api/household/intake also contains "/api/household".
            if (url.includes("/api/household/intake")) {
                if (init?.method === "POST") {
                    childAdded = true;
                    // The save re-stamps the session with the band the new age gives.
                    setSession({ id: 500, ageBand: 'adult' });
                    intakeState.prefill.household.emergencyContactName = "Aunt May" as unknown as null;
                    intakeState.prefill.household.emergencyContactPhone = "5125550000" as unknown as null;
                    intakeState.hasEmergencyContact = true;
                    return json({ state: intakeState, rejections: [] });
                }
                return json(intakeState);
            }
            if (url.includes("/api/household")) return json({ household: { householdMembers: childAdded ? [adult, child] : [adult] } });
            if (url.includes("/api/programs/10/participants")) return json({});
            if (url.includes("/api/programs/10")) return json(baseProgram({ participants: [] }));
            return res({}, 404);
        });
        renderPage();

        await screen.findByText("Robotics Club");
        // Unknown age goes straight to the intake panel.
        fireEvent.click(screen.getByRole("button", { name: "Add your date of birth to continue" }));

        // Panel mounts, prefilled with the adult's name; declare over 25, add the child + emergency contact.
        await screen.findByText("Finish setting up your household");
        fireEvent.click(screen.getByLabelText("I am over 25"));
        fireEvent.click(screen.getByRole("button", { name: "+ Add household member" }));
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New Kid" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "2015-01-01" } });
        fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Aunt May" } });
        fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "5125550000" } });
        fireEvent.click(screen.getByRole("button", { name: "Save & continue to enroll" }));

        // Back to member-select with the now-enrollable child selectable — but
        // still unchecked, so enrolling them stays a deliberate act.
        await screen.findByText("Which of your household wants to enroll?");
        expect(await screen.findByLabelText("New Kid")).not.toBeChecked();
        await toggleMember("New Kid");
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Successfully enrolled!" })),
        );
    });

    it("labels the entry button 'Continue enrollment' when a household member is payment-pending", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            // person.householdId is what links the participant to the viewer's
            // household in myEnrolled (the real API includes it).
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.getByText(/Kid One — Enrolled, not paid yet/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue enrollment" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Enroll" })).not.toBeInTheDocument();
    });

    // The API sends no status to a non-lead household member, so the row reads
    // as plain enrolled and nothing offers checkout.
    it("shows a household row without status as enrolled, with no pay affordance", async () => {
        setSession({ id: 101, ageBand: 'adult', householdId: 7 });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.getByText(/Kid One — Enrolled$/)).toBeInTheDocument();
        expect(screen.queryByText(/not paid/i)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Pay now" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enroll" })).toBeInTheDocument();
    });

    it("keeps the plain 'Enroll' label when household enrollments are all paid", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "ACTIVE", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Enroll" })).toBeInTheDocument();
    });

    it("over-25 adult with only an already-enrolled child sees a no-eligible message, not a DOB error", async () => {
        setSession({ id: 200, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": {
                household: {
                    householdMembers: [
                        { id: 200, name: "Parent Adult", dateOfBirth: null, isDeclaredAdult: true },
                        { id: 201, name: "Only Kid", dateOfBirth: "2015-01-01" },
                    ],
                },
            },
            "/api/programs/10": baseProgram({ participants: [{ personId: 201, status: "PENDING" }], minAge: 5, maxAge: 16 }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        // Declared adult reads as "(Adult)", never the confusing "(DOB missing)".
        expect(screen.getByText("(Adult)")).toBeInTheDocument();
        expect(screen.queryByText("(DOB missing)")).not.toBeInTheDocument();
        // PENDING enrollment is a RESUMABLE state, not a dead end: labeled as
        // payment-pending and selectable, with the enroll button available — NOT
        // the misleading household-setup affordance. Resuming payment is still an
        // explicit click, so the row is not pre-checked.
        expect(screen.getByText("(Not paid yet — select to pay now)")).toBeInTheDocument();
        expect(screen.getByLabelText("Only Kid")).not.toBeChecked();
        expect(screen.getByLabelText("Only Kid")).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Finish setting up your household to enroll" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Complete Enrollment" })).toBeInTheDocument();
    });

    it("priced program with no Shopify variant configured aborts before enrolling", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        const fetchMock = mockFetchJson({
            "/api/programs/10/participants": { ok: true },
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 7000, minAge: null, maxAge: null }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByText("Treehouse Member Price:")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));
        // No chargeable variant → persistent error, and NO enrollment is created.
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({
                color: "red",
                autoClose: false,
                message: "Cannot enroll: no pricing variant set for this program — set one in program-ops.",
            })),
        );
        expect(fetchMock).not.toHaveBeenCalledWith("/api/programs/10/participants", expect.anything());
    });

    it("shows a not-found card and navigates back to the directory", async () => {
        setSession(null, "unauthenticated");
        mockFetchJson({});
        renderPage();

        expect(await screen.findByText("Program not found.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Back to Directory" }));
        expect(router.push).toHaveBeenCalledWith("/programs");
    });

    it("offers a signed-out visitor on a not-found program a sign-in that returns to it", async () => {
        setSession(null, "unauthenticated");
        mockFetchJson({});
        renderPage();

        fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
        expect(router.push).toHaveBeenCalledWith("/signin?callbackUrl=%2Fprograms%2F10");
    });

    it("offers no sign-in on a not-found program to a signed-in visitor", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": household });
        renderPage();

        expect(await screen.findByText("Program not found.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    });

    it("routes a logged-out visitor through /signin (carrying the return URL) before enrolling (auth-first)", async () => {
        setSession(null, "unauthenticated");
        mockFetchJson({ "/api/programs/10": baseProgram() });
        renderPage();

        await screen.findByText("Robotics Club");
        // Single auth-first CTA — no anonymous "Register (New User)" leak.
        await screen.findByRole("button", { name: "Sign in to enroll" });
        expect(screen.queryByRole("button", { name: "Register (New User)" })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Sign in to enroll" }));
        // LOCAL never calls Google directly; /signin decides Google vs. the dev picker by env.
        expect(signIn).not.toHaveBeenCalled();
        expect(router.push).toHaveBeenCalledWith("/signin?callbackUrl=%2Fprograms%2F10");
    });

    it("navigates back and to the manage screen for authorized managers", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({ "/api/programs/10": baseProgram({ leadMentorId: 101 }), "/api/household/intake": intakeWithContact, "/api/household": household });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Manage Program" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Manage Program" }));
        expect(router.push).toHaveBeenCalledWith("/program-ops/programs/10");

        fireEvent.click(screen.getByRole("button", { name: "← Back" }));
        expect(router.back).toHaveBeenCalled();
    });

    it("requests a payment plan for a priced program", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        const fetchMock = mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }),
            "/api/programs/10/participants": { ok: true },
            "/api/programs/10/request-payment-plan": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        await requestPlan();
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Requested! Please check your email/) })),
        );
        expect(fetchMock).toHaveBeenCalledWith("/api/programs/10/request-payment-plan", expect.objectContaining({ method: "POST" }));
        const planCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("request-payment-plan"));
        expect(JSON.parse(String((planCall![1] as RequestInit).body))).toEqual(
            expect.objectContaining({ kind: "PAYMENT_PLAN" }),
        );
    });

    it("reports an error when starting enrollment for the payment plan fails", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }),
            "/api/programs/10/participants": () => ({ error: "Already pending." }),
        });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10/participants")) return res({ error: "Already pending." }, 400);
            if (url.includes("/api/household/intake")) return res(intakeWithContact);
            if (url.includes("/api/household")) return res(household, 200);
            if (url.includes("/api/programs/10")) return res(baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }), 200);
            return res({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        await requestPlan();
        await errorShown("Already pending.");
    });

    it("reports a finance-committee alert failure after a successful enrollment start", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10/request-payment-plan")) return res({}, 500);
            if (url.includes("/api/programs/10/participants")) return res({}, 200);
            if (url.includes("/api/household/intake")) return res(intakeWithContact);
            if (url.includes("/api/household")) return res(household, 200);
            if (url.includes("/api/programs/10")) return res(baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }), 200);
            return res({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        await requestPlan();
        await errorShown(/failed to alert the Scholarship Review Team/);
    });

    describe("payment plan for a child who already has an enrollment row", () => {
        async function requestPlanAfterConflict(plan: { status: number; body: Record<string, unknown> }) {
            setSession({ id: 101, ageBand: 'adult' });
            const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
                const url = typeof input === "string" ? input : input.toString();
                if (url.includes("/api/programs/10/request-payment-plan")) return res(plan.body, plan.status);
                if (url.includes("/api/programs/10/participants")) return res({ error: "Participant is already enrolled in this program." }, 409);
                if (url.includes("/api/household/intake")) return res(intakeWithContact);
                if (url.includes("/api/household")) return res(household, 200);
                if (url.includes("/api/programs/10")) return res(baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }), 200);
                return res({}, 404);
            });
            global.fetch = fetchMock;
            renderPage();
            await screen.findByText("Robotics Club");
            fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
            await screen.findByText("Which of your household wants to enroll?");

            await toggleMember("Kid One");
            await requestPlan();
            return fetchMock;
        }

        it("records the request for an unpaid child", async () => {
            const fetchMock = await requestPlanAfterConflict({ status: 200, body: { success: true } });
            await waitFor(() =>
                expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Requested! Please check your email/) })),
            );
            const planCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("request-payment-plan"));
            expect(planCall).toBeDefined();
            expect(screen.queryByText(/already enrolled/)).not.toBeInTheDocument();
        });

        it("names the child and shows the plan route's refusal for a child not awaiting payment", async () => {
            await requestPlanAfterConflict({ status: 409, body: { error: "This enrollment is not awaiting payment" } });
            await errorShown("Kid One: This enrollment is not awaiting payment");
            errorNotShown(/Enrolled as pending/);
            expect(notifications.show).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Requested!/) }));
        });

        it("does not claim a new enrollment when the plan route fails", async () => {
            await requestPlanAfterConflict({ status: 500, body: { error: "Failed to request payment plan" } });
            await errorShown(/Kid One: We couldn't send your request to the Scholarship Review Team/);
            errorNotShown(/Enrolled as pending/);
        });
    });

    it("shows a network-error message when requesting a payment plan throws", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": household, "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        global.fetch = jest.fn().mockRejectedValue(new Error("down"));
        await requestPlan();
        await errorShown("Couldn't reach the server. Check your connection and try again.");
    });

    it("enrolls multiple selected household members and reports the plural success message", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ minAge: null, maxAge: null }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        fireEvent.click(screen.getByLabelText("Too Young"));
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Successfully enrolled 2 members!" })),
        );
    });

    it("treats a 409 already-enrolled response as a successful outcome, even with no body", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10/participants")) {
                return { ok: false, status: 409, text: async () => "" } as Response;
            }
            if (url.includes("/api/household/intake")) return res(intakeWithContact);
            if (url.includes("/api/household")) return res(household, 200);
            if (url.includes("/api/programs/10")) return res(baseProgram({ minAge: null, maxAge: null }), 200);
            return res({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Successfully enrolled!" })),
        );
    });

    // This picker only ever lists the caller's own household, so every enrollment
    // started here is conflicted and the server refuses the limit override even for
    // a sysadmin. Offering Force Enroll would be a button that always re-fails —
    // the refusal reason is shown instead, and the request never carries `override`.
    it("offers no force-enroll on a requiresOverride refusal — shows the reason instead", async () => {
        setSession({ id: 5, isSysadmin: true, ageBand: 'adult' });
        const bodies: string[] = [];
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/household/intake")) return res(intakeWithContact);
            if (url.includes("/api/household")) return res(household, 200);
            if (url.includes("/api/programs/10/participants")) {
                bodies.push(String(init?.body ?? ""));
                return res({ error: "Too young for this program.", requiresOverride: true }, 400);
            }
            if (url.includes("/api/programs/10")) return res(baseProgram({ minAge: null, maxAge: null, leadMentorId: 5 }), 200);
            return res({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));

        await errorShown("Kid One: Too young for this program.");
        expect(screen.queryByText("Warning: Enrollment rules not met.")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Force Enroll (Override)" })).not.toBeInTheDocument();
        expect(bodies.every(b => !JSON.parse(b).override)).toBe(true);
    });

    it("shows a network-error message when enrollment throws", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": household, "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await toggleMember("Kid One");
        global.fetch = jest.fn().mockRejectedValue(new Error("down"));
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await errorShown("Couldn't reach the server. Check your connection and try again.");
    });

    it("redirects to Shopify checkout for a priced enrollment with a configured variant", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com"); // redirect requires a store domain
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        mockFetchJson({
            "/api/programs/10/discount-code": { code: null, signature: "sig" },
            "/api/household/intake": intakeWithContact, "/api/household": memberHousehold,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant" }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
    });

    // Single-pool model: an ACTIVE member checking out into a single-variant
    // program fetches a server-minted discount code before redirecting.
    it("fetches a member discount code before redirecting for a single-pool program", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        const fetchMock = mockFetchJson({
            "/api/programs/10/discount-code": { code: "PRG10-MOCKED", signature: "sig" },
            "/api/household/intake": intakeWithContact, "/api/household": memberHousehold,
            "/api/programs/10": baseProgram({
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null,
                shopifyVariantId: "gid://single-pool",
            }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
        await waitFor(() =>
            expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/programs/10/discount-code"))).toBe(true),
        );
    });

    // One order pays for one household, paid by its lead: the server refuses a mixed
    // checkout (400) or a non-lead payer (403) and the page shows its message
    // instead of redirecting.
    it.each([
        [400, "Everyone in one checkout must be from your household. Pay for each household separately."],
        [403, "Only a household lead can pay for the household."],
    ])("sends the checkout's children for the discount code and stops on a %i refusal", async (status, refusal) => {
        setSession({ id: 101, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        const routes = mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": memberHousehold,
            "/api/programs/10": baseProgram({
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null,
                shopifyVariantId: "gid://single-pool",
            }),
            "/api/programs/10/participants": { ok: true },
        });
        const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
            String(input).includes("/discount-code")
                ? res({ error: refusal }, status)
                : routes(input, init),
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        await errorShown(refusal);
        expect(screen.queryByText("Redirecting to Shopify for secure payment...")).not.toBeInTheDocument();
        const discountCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/discount-code"));
        expect(JSON.parse(String(discountCall?.[1]?.body)).participantIds).toHaveLength(1);
    });

    describe("a priced checkout where some children are refused", () => {
        const pricedProgram = baseProgram({ nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant" });

        function routesRefusing(refusedIds: number[]) {
            const routes = mockFetchJson({
                "/api/programs/10/discount-code": { code: null, signature: "sig" },
                "/api/household/intake": intakeWithContact, "/api/household": household,
                "/api/programs/10": pricedProgram,
                "/api/programs/10/participants": { ok: true },
            });
            const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                if (String(input).includes("/participants") && init?.method === "POST"
                    && refusedIds.includes(JSON.parse(String(init.body)).participantId)) {
                    return res({ error: "Program has reached maximum capacity." }, 400);
                }
                return routes(input, init);
            });
            global.fetch = fetchMock as unknown as typeof fetch;
            return fetchMock;
        }

        const discountCalls = (fetchMock: jest.Mock) =>
            fetchMock.mock.calls.filter(([input]) => String(input).includes("/discount-code"));

        async function payFor(...names: string[]) {
            setSession({ id: 100, ageBand: 'adult' });
            setShopifyStoreDomain("shop.example.com");
            renderPage();
            await screen.findByText("Robotics Club");
            fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
            for (const name of names) await toggleMember(name);
            fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));
        }

        it("pauses with the refusal named, then checks out only the accepted child", async () => {
            const fetchMock = routesRefusing([102]);
            await payFor("Kid One", "Too Young");

            expect(await screen.findByText("Too Young: Program has reached maximum capacity.")).toBeInTheDocument();
            expect(screen.getByText("Continue to checkout for Kid One?")).toBeInTheDocument();
            expect(discountCalls(fetchMock)).toHaveLength(0);
            expect(screen.queryByText("Redirecting to Shopify for secure payment...")).not.toBeInTheDocument();

            fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));
            expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
            const calls = discountCalls(fetchMock);
            expect(calls).toHaveLength(1);
            expect(JSON.parse(String(calls[0][1]?.body)).participantIds).toEqual([101]);
        });

        it("offers no checkout when every child is refused", async () => {
            const fetchMock = routesRefusing([101, 102]);
            await payFor("Kid One", "Too Young");

            expect(await screen.findByText("Kid One: Program has reached maximum capacity.")).toBeInTheDocument();
            expect(screen.getByText("Too Young: Program has reached maximum capacity.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Continue to checkout" })).not.toBeInTheDocument();
            expect(discountCalls(fetchMock)).toHaveLength(0);
            expect(screen.queryByText("Redirecting to Shopify for secure payment...")).not.toBeInTheDocument();
        });

        it("goes straight to checkout when nobody is refused", async () => {
            const fetchMock = routesRefusing([]);
            await payFor("Kid One", "Too Young");

            expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Continue to checkout" })).not.toBeInTheDocument();
            expect(JSON.parse(String(discountCalls(fetchMock)[0][1]?.body)).participantIds).toEqual([101, 102]);
        });
    });

    // Without the server's checkout signature the order would activate nobody, so
    // the page does not send the family to the store.
    it("stays on the page when the checkout signature can't be fetched", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        mockFetchJson({
            "/api/programs/10/discount-code": { code: null },
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant" }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        await errorShown("We couldn't start the checkout. Please try again.");
        expect(screen.queryByText("Redirecting to Shopify for secure payment...")).not.toBeInTheDocument();
    });

    // The payment-pending resume path: an already-enrolled-but-unpaid household
    // must be able to re-run checkout (participants POST 409s -> folded back in;
    // a FRESH single-use discount code is minted — the old one is 48h/one-use).
    it("lets a payment-pending member resume checkout with a fresh discount code", async () => {
        setSession({ id: 100, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        // One-member household whose only participant is already PENDING — the
        // resume case: nobody new to enroll, payment still owed. The viewer is an
        // adult: only a known adult may finish a checkout.
        const memberHousehold = { household: {
            householdMembers: [{ id: 100, name: "Jamie Guardian", dateOfBirth: "1990-01-01" }],
            orgMembership: { status: "ACTIVE" },
        } };
        const fetchMock = mockFetchJson({
            "/api/programs/10/discount-code": { code: "PRG10-FRESH", signature: "sig" },
            "/api/household/intake": intakeWithContact, "/api/household": memberHousehold,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 100, status: "PENDING" }],
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null,
                shopifyVariantId: "gid://single-pool",
            }),
            "/api/programs/10/participants": () => ({ error: "Participant is already enrolled in this program." }),
        });
        // 409 for the already-enrolled participant — the idempotent re-checkout path.
        const baseImpl = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("/api/programs/10/participants") && init?.method === "POST") {
                return res({ error: "Participant is already enrolled in this program." }, 409);
            }
            return baseImpl(input, init);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        // Selectable and not disabled — but unchecked, so resuming the checkout
        // is a deliberate click like any other enrollment.
        expect(await screen.findByLabelText("Jamie Guardian")).not.toBeChecked();
        expect(screen.getByText("(Not paid yet — select to pay now)")).toBeInTheDocument();

        await toggleMember("Jamie Guardian");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
        expect(screen.queryByText("Pay again anyway?")).not.toBeInTheDocument();
        await waitFor(() =>
            expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/programs/10/discount-code"))).toBe(true),
        );
    });

    // Repeat payments are matched per child: a sibling paid earlier is no reason to
    // warn about a new sibling's checkout.
    it("does not warn when only a sibling is already paid", async () => {
        setSession({ id: 100, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        mockFetchJson({
            "/api/programs/10/discount-code": { code: null, signature: "sig" },
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 102, status: "ACTIVE", person: { name: "Too Young", householdId: 7 } }],
                nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant",
            }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
        expect(screen.queryByText("Pay again anyway?")).not.toBeInTheDocument();
    });

    // The roster is re-read at checkout: a child paid since the page loaded (another
    // tab, the other parent) is flagged before a second payment, and the family may
    // still continue.
    it("warns when the same child is already paid, and lets the family pay again", async () => {
        setSession({ id: 100, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        const priced = { nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant" };
        let programReads = 0;
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const json = (body: unknown, status = 200) => res(body, status);
            if (url.includes("/api/programs/10/participants") && init?.method === "POST") return json({ error: "Participant is already enrolled in this program." }, 409);
            if (url.includes("/discount-code")) return json({ code: null, signature: "sig" });
            if (url.includes("/api/household/intake")) return json(intakeWithContact);
            if (url.includes("/api/household")) return json(household);
            if (url.endsWith("/api/programs/10")) {
                programReads += 1;
                return json(baseProgram({
                    ...priced,
                    participants: programReads === 1 ? [] : [{ personId: 101, status: "ACTIVE", person: { name: "Kid One", householdId: 7 } }],
                }));
            }
            return json({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Kid One is already paid.")).toBeInTheDocument();
        expect(screen.queryByText("Redirecting to Shopify for secure payment...")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Pay again anyway" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
    });

    // The repeat-payment check is advisory: a failed roster re-read is logged and
    // checks the loaded roster, and checkout still proceeds.
    it.each([
        { outcome: "returns 500", failedRead: () => Promise.resolve(res({}, 500)) },
        { outcome: "throws", failedRead: () => Promise.reject(new Error("down")) },
    ])("logs and continues to checkout when the roster re-read $outcome", async ({ failedRead }) => {
        setSession({ id: 100, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        let programReads = 0;
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const json = (body: unknown, status = 200) => res(body, status);
            if (url.includes("/api/programs/10/participants")) return json({ ok: true });
            if (url.includes("/discount-code")) return json({ code: null, signature: "sig" });
            if (url.includes("/api/household/intake")) return json(intakeWithContact);
            if (url.includes("/api/household")) return json(household);
            if (url.endsWith("/api/programs/10")) {
                programReads += 1;
                if (programReads > 1) return failedRead();
                return json(baseProgram({
                    nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant",
                    participants: [],
                }));
            }
            return json({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await toggleMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("roster re-read failed"), expect.any(Error));
        warnSpy.mockRestore();
    });

    // Membership-duration guard: pricing decisions use the server-computed
    // viewerMemberPricingEligible flag over the household-status-derived isMember,
    // so a current member not covered through the program's end doesn't get the
    // discount even though /api/household still reports an ACTIVE membership.
    it("still checks the checkout's household when the server flag says pricing-ineligible", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        const fetchMock = mockFetchJson({
            "/api/programs/10/discount-code": { code: null, signature: "sig" },
            "/api/household/intake": intakeWithContact, "/api/household": memberHousehold,
            "/api/programs/10": baseProgram({
                orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null,
                shopifyVariantId: "gid://single-pool",
                viewerIsMember: true, viewerMemberPricingEligible: false,
            }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        // The household/EC probes that gate the button's disabled state are still
        // in flight right after the panel appears — pick a member, then wait for
        // it to actually enable (avoids a race with populateHousehold's fetches).
        await toggleMember("Kid One");
        await waitFor(() => expect(screen.getByRole("button", { name: "Pay on Shopify" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        await screen.findByText("Redirecting to Shopify for secure payment...");
        const discountCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/discount-code"));
        expect(JSON.parse(String(discountCall?.[1]?.body)).participantIds).toHaveLength(1);
    });

    it("shows the renew notice when the viewer is a member but not eligible for member pricing on this program", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ viewerIsMember: true, viewerMemberPricingEligible: false }),
        });
        renderPage();
        expect(await screen.findByText(/renew your membership first to enroll at the member price/)).toBeInTheDocument();
    });

    it("does not show the renew notice when the member is pricing-eligible or the fields are absent", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ viewerIsMember: true, viewerMemberPricingEligible: true }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.queryByText(/renew your membership first/)).not.toBeInTheDocument();
    });

    it("does not show the renew notice for an anonymous caller (fields absent)", async () => {
        setSession(null, "unauthenticated");
        mockFetchJson({ "/api/programs/10": baseProgram() });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.queryByText(/renew your membership first/)).not.toBeInTheDocument();
    });

    it.each<[string, Record<string, unknown>]>([
        ["Full", { enrollmentClosedBy: "FULL", phase: "RUNNING" }],
        ["Sales ended", { enrollmentClosedBy: "SALE_ENDED", phase: "UPCOMING" }],
        ["Running", { enrollmentClosedBy: "CLOSED", phase: "RUNNING" }],
        ["Ended", { enrollmentClosedBy: "CLOSED", phase: "FINISHED" }],
        ["", { enrollmentClosedBy: "CLOSED", phase: "SOMETHING_ELSE" }],
        ["Upcoming", { enrollmentClosedBy: "CLOSED", phase: "UPCOMING" }],
    ])("shows the closed-enrollment reason '%s' from the server's cause and the phase", async (expected, overrides) => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({ "/api/programs/10": baseProgram({ enrollmentStatus: "CLOSED", ...overrides }) });
        renderPage();
        await screen.findByText("Robotics Club");
        if (expected) {
            expect(screen.getByRole("button", { name: new RegExp(`Enrollment Closed \\(${expected}\\)`) })).toBeInTheDocument();
        } else {
            expect(screen.getByRole("button", { name: "Enrollment Closed" })).toBeInTheDocument();
        }
    });

    // enrollmentStatus stays OPEN: the server's cause alone closes the page.
    it.each([
        ["Full", "FULL"],
        ["Sales ended", "SALE_ENDED"],
    ])("closes an OPEN program the server would refuse (%s)", async (reason, closedBy) => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({ "/api/programs/10": baseProgram({ enrollmentClosedBy: closedBy }) });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: new RegExp(`Enrollment Closed \\(${reason}\\)`) })).toBeDisabled();
        expect(screen.getByText("Closed")).toBeInTheDocument();
    });

    it("keeps a full or ended program payable for a household with an unpaid claim", async () => {
        setSession({ id: 100, householdId: 7, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10": baseProgram({
                enrollmentClosedBy: "FULL",
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Continue enrollment" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
    });

    // The daily sweep closes enrollment the day after the off-sale date.
    it.each([
        ["closed by the off-sale sweep", "SALE_ENDED"],
        ["closed by hand", "CLOSED"],
    ])("keeps an unpaid claim payable once enrollment is %s", async (_label, closedBy) => {
        setSession({ id: 100, householdId: 7, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10": baseProgram({
                enrollmentStatus: "CLOSED",
                enrollmentClosedBy: closedBy,
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Continue enrollment" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
    });

    it("keeps an unpaid claim payable on a running program whose enrollment has closed", async () => {
        setSession({ id: 100, householdId: 7, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10": baseProgram({
                phase: "RUNNING",
                enrollmentStatus: "CLOSED",
                enrollmentClosedBy: "SALE_ENDED",
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Continue enrollment" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
    });

    it("offers no payment once the program has ended and sends the household to the board", async () => {
        setSession({ id: 100, householdId: 7, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10": baseProgram({
                phase: "FINISHED",
                enrollmentStatus: "CLOSED",
                enrollmentClosedBy: "SALE_ENDED",
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.queryByRole("button", { name: "Continue enrollment" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Enrollment Closed/ })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Pay now" })).not.toBeInTheDocument();
        expect(screen.getByText(/This program has ended; ask the board about payment\./)).toBeInTheDocument();
    });

    it("offers no new claim after the off-sale sweep to a household with nothing unpaid", async () => {
        setSession({ id: 100, householdId: 7, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10": baseProgram({
                enrollmentStatus: "CLOSED",
                enrollmentClosedBy: "SALE_ENDED",
                participants: [{ personId: 101, status: "ACTIVE", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: /Enrollment Closed \(Sales ended\)/ })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Pay now" })).not.toBeInTheDocument();
    });

    it("shows a disabled closed CTA to a signed-out visitor", async () => {
        setSession(null, "unauthenticated");
        mockFetchJson({ "/api/programs/10": baseProgram({ enrollmentStatus: "CLOSED", enrollmentClosedBy: "CLOSED", phase: "UPCOMING", maxParticipants: null }) });
        renderPage();

        await screen.findByText("Robotics Club");
        // Auth-first CTA reuses the same disabled-closed treatment as the logged-in Enroll button.
        expect(screen.getByRole("button", { name: /Enrollment Closed \(Upcoming\)/ })).toBeDisabled();
        expect(screen.getByText("Closed")).toBeInTheDocument();
    });

    it("renders optional detail fields when absent or present", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        mockFetchJson({
            "/api/programs/10": baseProgram({
                leadMentor: null,
                startAt: "2026-07-01T00:00:00.000Z",
                endAt: "2026-08-01T00:00:00.000Z",
                enrollmentStatus: "WHITELIST",
                orgMemberPriceCents: 0,
                nonOrgMemberPriceCents: 0,
            }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.queryByText("Coach K")).not.toBeInTheDocument();
        expect(screen.getByText("Invite Only")).toBeInTheDocument();
        expect(screen.getByText("Free")).toBeInTheDocument();
    });

    it("shows a failed household load in the picker with a retry, never an empty household", async () => {
        setSession({ id: 777, ageBand: 'adult' });
        mockFetchJson({ "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByText("Couldn't load your household")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Complete Enrollment" })).not.toBeInTheDocument();
    });

    // The enroll routes don't check the emergency contact, so the probe is the gate.
    it("blocks enrolment when the emergency-contact probe can't answer", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/household/intake")) return res({ error: "User not found." }, 400);
            if (url.includes("/api/household")) return res(household);
            if (url.includes("/api/programs/10")) return res(baseProgram({ minAge: null, maxAge: null }));
            return res({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByText("Couldn't load your emergency contact")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Complete Enrollment" })).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Kid One")).not.toBeInTheDocument();
    });

    it("falls back to a solo household entry when the caller has no household", async () => {
        setSession({ id: 777, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": { household: null }, "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByLabelText("Myself")).toBeInTheDocument();
    });

    it("offers household setup when the solo fallback can't clear an age-gated program", async () => {
        setSession({ id: 777, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": { household: null }, "/api/programs/10": baseProgram({ participants: [] }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));

        // The fallback entry has no DOB, so the program's 5-18 range blocks it.
        // Without the setup affordance the panel is a dead end: the one row is
        // disabled, and the hint asks for a box that can't be checked.
        expect(await screen.findByRole("button", { name: "Finish setting up your household to enroll" })).toBeInTheDocument();
        expect(screen.getByLabelText("Myself")).toBeDisabled();
        expect(screen.queryByText("Check the box next to each person you want to enroll.")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Complete Enrollment" })).not.toBeInTheDocument();
    });

    it("highlights the emergency contact the intake save refused and keeps the form filled in", async () => {
        setSession({ id: 300, ageBand: 'unknown' });
        const intakeState = { prefill: {
            household: { emergencyContactName: null, emergencyContactPhone: null, emergencyContactEmail: null },
            primaryParent: { id: 300, name: "New Adult", email: null, dob: null, over25: false, allergies: null },
            secondaryParent: null, children: [],
        } };
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("/api/household/intake")) {
                return init?.method === "POST"
                    ? res({ error: "That emergency contact is in your household.", fields: ["emergencyContact"] }, 400)
                    : res(intakeState);
            }
            if (url.includes("/api/household")) return res({ household: { householdMembers: [{ id: 300, name: "New Adult", dateOfBirth: null }] } });
            if (url.includes("/api/programs/10")) return res(baseProgram({ participants: [], minAge: null, maxAge: null }));
            return res({}, 404);
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Add your date of birth to continue" }));
        await screen.findByText("Finish setting up your household");
        fireEvent.change(screen.getByLabelText(/Emergency contact name/), { target: { value: "Pat Peer" } });
        fireEvent.change(screen.getByLabelText(/Emergency contact phone/), { target: { value: "5125550000" } });
        fireEvent.click(screen.getByRole("button", { name: "Save & continue to enroll" }));

        await errorShown("That emergency contact is in your household.");
        expect(screen.getAllByText("Add an emergency contact who isn't in your household.").length).toBeGreaterThan(0);
        expect(screen.getByLabelText(/Emergency contact name/)).toHaveValue("Pat Peer");
    });

    it("sends one claim per child when Pay on Shopify is clicked twice", async () => {
        setSession({ id: 101, ageBand: 'adult' });
        setShopifyStoreDomain("shop.example.com");
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        const routes = mockFetchJson({
            "/api/programs/10/discount-code": { code: null },
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ nonOrgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant" }),
        });
        const claims = jest.fn();
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes("/participants")) {
                claims();
                await held;
                return res({ ok: true });
            }
            return routes(input, init);
        }) as unknown as typeof fetch;
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await toggleMember("Kid One");
        const pay = screen.getByRole("button", { name: "Pay on Shopify" });
        fireEvent.click(pay);
        fireEvent.click(pay);
        await waitFor(() => expect(claims).toHaveBeenCalledTimes(1));
        expect(pay).toBeDisabled();

        release();
        await errorShown("We couldn't start the checkout. Please try again.");
        expect(claims).toHaveBeenCalledTimes(1);
    });

    it("pre-checks nobody, so the enroll button starts disabled", async () => {
        setSession({ id: 999, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": household, "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByLabelText("Kid One")).not.toBeChecked();
        expect(screen.getByLabelText("Too Young")).not.toBeChecked();
        expect(screen.getByRole("button", { name: "Complete Enrollment" })).toBeDisabled();
        expect(screen.getByText("Check the box next to each person you want to enroll.")).toBeInTheDocument();
    });

    it("priced program: the scholarship request button starts disabled until someone is selected", async () => {
        setSession({ id: 999, ageBand: 'adult' });
        mockFetchJson({ "/api/household/intake": intakeWithContact, "/api/household": household, "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByLabelText("Kid One")).not.toBeChecked();
        const requestButton = screen.getByRole("button", { name: /request a scholarship or payment plan/i });
        expect(requestButton).toBeDisabled();
        expect(screen.getByRole("button", { name: "Pay on Shopify" })).toBeDisabled();

        await toggleMember("Kid One");
        expect(requestButton).toBeEnabled();
    });

    // An adult clears a program with no upper age limit, so auto-selecting the
    // signed-in caller would enroll a household lead who came only to pay for a
    // child — stranding an unpaid PENDING row that holds a capacity seat.
    it("does not pre-check the signed-in adult on a program with no upper age limit", async () => {
        setSession({ id: 100, ageBand: 'adult' });
        mockFetchJson({
            "/api/household/intake": intakeWithContact, "/api/household": household,
            "/api/programs/10": baseProgram({ participants: [], minAge: 9, maxAge: null }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        // Jamie is eligible (no maxAge to fail), but never auto-selected.
        expect(await screen.findByLabelText("Jamie Guardian")).toBeEnabled();
        expect(screen.getByLabelText("Jamie Guardian")).not.toBeChecked();
        expect(screen.getByLabelText("Kid One")).not.toBeChecked();
        expect(screen.getByRole("button", { name: "Complete Enrollment" })).toBeDisabled();
    });

    it("shows a failed program load in place of the page, with a retry", async () => {
        global.fetch = jest.fn().mockResolvedValue(res({ error: "You can't see this program." }, 403));
        renderPage();
        expect(await screen.findByText("Couldn't load this program")).toBeInTheDocument();
        expect(screen.getByText("You can't see this program.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("falls back to a bare Not Found card when the program response has no message", async () => {
        global.fetch = jest.fn().mockResolvedValue(res(null, 200));
        renderPage();
        expect(await screen.findByText("Not Found")).toBeInTheDocument();
    });
});
