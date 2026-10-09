/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
import { screen, waitFor, fireEvent } from "@testing-library/react";
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
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

function renderPage() {
    return renderWithProviders(<ProgramEnrollmentPage params={params} />);
}

// Nobody is ever pre-checked, so every enrolling test picks its participants the
// way a household does. findByLabelText waits out the in-flight household fetch.
async function selectMember(name: string) {
    fireEvent.click(await screen.findByLabelText(name));
}

/** Open the request modal, state which ask it is, send. The kind is required, so
 *  "Send request" stays disabled until one is picked. */
async function requestPlan(kind: RegExp = /^Payment plan$/) {
    fireEvent.click(screen.getByRole("button", { name: /request a scholarship or payment plan/i }));
    fireEvent.click(await screen.findByRole("radio", { name: kind }));
    fireEvent.click(screen.getByRole("button", { name: /^Send request$/ }));
}

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
            "/api/household": household,
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

        await selectMember("Kid One");
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
            "/api/household": household,
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
        expect(screen.queryByText(/payment pending/i)).not.toBeInTheDocument();
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
            "/api/household": household,
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

    it("routes a viewer of unverifiable age into intake rather than blocking on a lead", async () => {
        setSession({ id: 300, ageBand: 'unknown' });
        mockFetchJson({
            "/api/household": { household: { householdMembers: [{ id: 300, name: "New Adult", dateOfBirth: null }] } },
            "/api/programs/10": baseProgram({ participants: [], minAge: null, maxAge: null }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        // A brand-new adult is "age unverifiable", not a minor — the remedy is the
        // intake panel (DOB or "over 25"), never a lead they don't have.
        expect(screen.getByText("(DOB missing)")).toBeInTheDocument();
        expect(screen.queryByText("(A household lead must enroll you)")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Finish setting up your household to enroll" })).toBeInTheDocument();
    });

    it("first-time user finishes household setup, then enrolls a child (auth-first)", async () => {
        setSession({ id: 500, ageBand: 'unknown' });
        let childAdded = false;
        const adult = { id: 500, name: "New Parent", dateOfBirth: null };
        const child = { id: 501, name: "New Kid", dateOfBirth: "2015-01-01" };
        // Process-free intake state; the POST mutates it (child + emergency
        // contact now saved) so the subsequent EC probe reads them back.
        const intakeState = {
            prefill: {
                household: { emergencyContactName: null, emergencyContactPhone: null, emergencyContactEmail: null, line1: null },
                primaryParent: { id: 500, name: "New Parent", email: null, dob: null, over25: false, allergies: null },
                secondaryParent: null,
                children: [] as unknown[],
            },
        };
        const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as Response);
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            // Order matters: /api/household/intake also contains "/api/household".
            if (url.includes("/api/household/intake")) {
                if (init?.method === "POST") {
                    childAdded = true;
                    intakeState.prefill.household.emergencyContactName = "Aunt May" as unknown as null;
                    intakeState.prefill.household.emergencyContactPhone = "5125550000" as unknown as null;
                    return json({ state: intakeState, rejections: [] });
                }
                return json(intakeState);
            }
            if (url.includes("/api/household")) return json({ household: { householdMembers: childAdded ? [adult, child] : [adult] } });
            if (url.includes("/api/programs/10/participants")) return json({});
            if (url.includes("/api/programs/10")) return json(baseProgram({ participants: [] }));
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        renderPage();

        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        // No enrollable participant yet -> first-time setup affordance.
        fireEvent.click(await screen.findByRole("button", { name: "Finish setting up your household to enroll" }));

        // Panel mounts, prefilled with the adult's name; add the child + emergency contact.
        await screen.findByText("Finish setting up your household");
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
        await selectMember("New Kid");
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Successfully enrolled!" })),
        );
    });

    it("labels the entry button 'Continue enrollment' when a household member is payment-pending", async () => {
        setSession({ id: 101 });
        mockFetchJson({
            "/api/household": household,
            // person.householdId is what links the participant to the viewer's
            // household in myEnrolled (the real API includes it).
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "PENDING", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.getByText(/Kid One — Enrolled, payment pending/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue enrollment" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Enroll" })).not.toBeInTheDocument();
    });

    it("keeps the plain 'Enroll' label when household enrollments are all paid", async () => {
        setSession({ id: 101 });
        mockFetchJson({
            "/api/household": household,
            "/api/programs/10": baseProgram({
                participants: [{ personId: 101, status: "ACTIVE", person: { name: "Kid One", householdId: 7 } }],
            }),
        });
        renderPage();
        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Enroll" })).toBeInTheDocument();
    });

    it("over-25 adult with only an already-enrolled child sees a no-eligible message, not a DOB error", async () => {
        setSession({ id: 200 });
        mockFetchJson({
            "/api/household": {
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
        expect(screen.getByText("(Payment pending — select to finish payment)")).toBeInTheDocument();
        expect(screen.getByLabelText("Only Kid")).not.toBeChecked();
        expect(screen.getByLabelText("Only Kid")).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Finish setting up your household to enroll" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Complete Enrollment" })).toBeInTheDocument();
    });

    it("priced program with no Shopify variant configured aborts before enrolling", async () => {
        setSession({ id: 101 });
        const fetchMock = mockFetchJson({
            "/api/programs/10/participants": { ok: true },
            "/api/household": household,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 7000, minAge: null, maxAge: null }),
        });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByText("Treehouse Member Price:")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
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
        expect(router.push).toHaveBeenCalledWith("/signin?callbackUrl=/programs/10");
    });

    it("navigates back and to the manage screen for authorized managers", async () => {
        setSession({ id: 101 });
        mockFetchJson({ "/api/programs/10": baseProgram({ leadMentorId: 101 }), "/api/household": household });
        renderPage();

        await screen.findByText("Robotics Club");
        expect(screen.getByRole("button", { name: "Manage Program" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Manage Program" }));
        expect(router.push).toHaveBeenCalledWith("/program-ops/programs/10");

        fireEvent.click(screen.getByRole("button", { name: "← Back" }));
        expect(router.back).toHaveBeenCalled();
    });

    it("requests a payment plan for a priced program", async () => {
        setSession({ id: 101 });
        const fetchMock = mockFetchJson({
            "/api/household": household,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }),
            "/api/programs/10/participants": { ok: true },
            "/api/programs/10/request-payment-plan": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
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
        setSession({ id: 101 });
        mockFetchJson({
            "/api/household": household,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }),
            "/api/programs/10/participants": () => ({ error: "Already pending." }),
        });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10/participants")) return { ok: false, status: 400, json: async () => ({ error: "Already pending." }) } as Response;
            if (url.includes("/api/household")) return { ok: true, status: 200, json: async () => household } as Response;
            if (url.includes("/api/programs/10")) return { ok: true, status: 200, json: async () => baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }) } as Response;
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
        await requestPlan();
        expect(await screen.findByText("Already pending.")).toBeInTheDocument();
    });

    it("reports a finance-committee alert failure after a successful enrollment start", async () => {
        setSession({ id: 101 });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10/request-payment-plan")) return { ok: false, status: 500, json: async () => ({}) } as Response;
            if (url.includes("/api/programs/10/participants")) return { ok: true, status: 200, json: async () => ({}) } as Response;
            if (url.includes("/api/household")) return { ok: true, status: 200, json: async () => household } as Response;
            if (url.includes("/api/programs/10")) return { ok: true, status: 200, json: async () => baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }) } as Response;
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
        await requestPlan();
        expect(await screen.findByText(/failed to alert the Scholarship Review Team/)).toBeInTheDocument();
    });

    it("shows a network-error message when requesting a payment plan throws", async () => {
        setSession({ id: 101 });
        mockFetchJson({ "/api/household": household, "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
        global.fetch = jest.fn().mockRejectedValue(new Error("down"));
        await requestPlan();
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error requesting payment plan.", autoClose: false })),
        );
    });

    it("enrolls multiple selected household members and reports the plural success message", async () => {
        setSession({ id: 101 });
        mockFetchJson({
            "/api/household": household,
            "/api/programs/10": baseProgram({ minAge: null, maxAge: null }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
        fireEvent.click(screen.getByLabelText("Too Young"));
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Successfully enrolled 2 members!" })),
        );
    });

    it("treats a 409 already-enrolled response as a successful outcome without parsing a body", async () => {
        setSession({ id: 101 });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10/participants")) {
                return { ok: false, status: 409, json: async () => { throw new Error("should not be parsed"); } } as unknown as Response;
            }
            if (url.includes("/api/household")) return { ok: true, status: 200, json: async () => household } as Response;
            if (url.includes("/api/programs/10")) return { ok: true, status: 200, json: async () => baseProgram({ minAge: null, maxAge: null }) } as Response;
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await selectMember("Kid One");
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
        setSession({ id: 5, isSysadmin: true });
        const bodies: string[] = [];
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/household")) return { ok: true, status: 200, json: async () => household } as Response;
            if (url.includes("/api/programs/10/participants")) {
                bodies.push(String(init?.body ?? ""));
                return { ok: false, status: 400, json: async () => ({ error: "Too young for this program.", requiresOverride: true }) } as Response;
            }
            if (url.includes("/api/programs/10")) return { ok: true, status: 200, json: async () => baseProgram({ minAge: null, maxAge: null, leadMentorId: 5 }) } as Response;
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await selectMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));

        expect(await screen.findByText("Too young for this program.")).toBeInTheDocument();
        expect(screen.queryByText("Warning: Enrollment rules not met.")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Force Enroll (Override)" })).not.toBeInTheDocument();
        expect(bodies.every(b => !JSON.parse(b).override)).toBe(true);
    });

    it("shows a network-error message when enrollment throws", async () => {
        setSession({ id: 101 });
        mockFetchJson({ "/api/household": household, "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");

        await selectMember("Kid One");
        global.fetch = jest.fn().mockRejectedValue(new Error("down"));
        fireEvent.click(screen.getByRole("button", { name: "Complete Enrollment" }));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error during enrollment.", autoClose: false })),
        );
    });

    it("redirects to Shopify checkout for a priced enrollment with a configured variant", async () => {
        setSession({ id: 101 });
        setShopifyStoreDomain("shop.example.com"); // redirect requires a store domain
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        mockFetchJson({
            "/api/household": memberHousehold,
            "/api/programs/10": baseProgram({ orgMemberPriceCents: 5000, minAge: null, maxAge: null, shopifyVariantId: "gid://variant" }),
            "/api/programs/10/participants": { ok: true },
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        await screen.findByText("Which of your household wants to enroll?");
        await selectMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
    });

    // Single-pool model: an ACTIVE member checking out into a single-variant
    // program fetches a server-minted discount code before redirecting.
    it("fetches a member discount code before redirecting for a single-pool program", async () => {
        setSession({ id: 101 });
        setShopifyStoreDomain("shop.example.com");
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        const fetchMock = mockFetchJson({
            "/api/programs/10/discount-code": { code: "PRG10-MOCKED" },
            "/api/household": memberHousehold,
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
        await selectMember("Kid One");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
        await waitFor(() =>
            expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/programs/10/discount-code"))).toBe(true),
        );
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
            "/api/programs/10/discount-code": { code: "PRG10-FRESH" },
            "/api/household": memberHousehold,
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
                return { ok: false, status: 409, json: async () => ({ error: "Participant is already enrolled in this program." }) } as Response;
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
        expect(screen.getByText("(Payment pending — select to finish payment)")).toBeInTheDocument();

        await selectMember("Jamie Guardian");
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        expect(await screen.findByText("Redirecting to Shopify for secure payment...")).toBeInTheDocument();
        await waitFor(() =>
            expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/programs/10/discount-code"))).toBe(true),
        );
    });

    // Membership-duration guard: pricing decisions use the server-computed
    // viewerMemberPricingEligible flag over the household-status-derived isMember,
    // so a current member not covered through the program's end doesn't get the
    // discount even though /api/household still reports an ACTIVE membership.
    it("does NOT fetch a member discount code when the server flag says pricing-ineligible, despite an ACTIVE household membership", async () => {
        setSession({ id: 101 });
        setShopifyStoreDomain("shop.example.com");
        const memberHousehold = { household: { ...household.household, orgMembership: { status: "ACTIVE" } } };
        const fetchMock = mockFetchJson({
            "/api/household": memberHousehold,
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
        await selectMember("Kid One");
        await waitFor(() => expect(screen.getByRole("button", { name: "Pay on Shopify" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Pay on Shopify" }));

        await screen.findByText("Redirecting to Shopify for secure payment...");
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/discount-code"))).toBe(false);
    });

    it("shows the renew notice when the viewer is a member but not eligible for member pricing on this program", async () => {
        setSession({ id: 101 });
        mockFetchJson({
            "/api/household": household,
            "/api/programs/10": baseProgram({ viewerIsMember: true, viewerMemberPricingEligible: false }),
        });
        renderPage();
        expect(await screen.findByText(/renew your membership first to enroll at the member price/)).toBeInTheDocument();
    });

    it("does not show the renew notice when the member is pricing-eligible or the fields are absent", async () => {
        setSession({ id: 101 });
        mockFetchJson({
            "/api/household": household,
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

    it("shows different closed-enrollment reasons depending on fullness, phase, and count source", async () => {
        setSession({ id: 101 });
        const cases: [string, Record<string, unknown>][] = [
            ["Full", { maxParticipants: 1 }],
            ["Full", { maxParticipants: 5, _count: { participants: 5 } }],
            ["Running", { maxParticipants: null, phase: "RUNNING" }],
            ["Ended", { maxParticipants: null, phase: "FINISHED" }],
            ["", { maxParticipants: null, phase: "SOMETHING_ELSE" }],
            ["Upcoming", { maxParticipants: 1, phase: "UPCOMING", participants: undefined, _count: undefined }],
        ];
        for (const [expected, overrides] of cases) {
            mockFetchJson({ "/api/programs/10": baseProgram({ enrollmentStatus: "CLOSED", ...overrides }) });
            const { unmount } = renderPage();
            await screen.findByText("Robotics Club");
            if (expected) {
                expect(screen.getByRole("button", { name: new RegExp(`Enrollment Closed \\(${expected}\\)`) })).toBeInTheDocument();
            } else {
                expect(screen.getByRole("button", { name: "Enrollment Closed" })).toBeInTheDocument();
            }
            unmount();
        }
    });

    it("shows a disabled closed CTA to a signed-out visitor", async () => {
        setSession(null, "unauthenticated");
        mockFetchJson({ "/api/programs/10": baseProgram({ enrollmentStatus: "CLOSED", phase: "UPCOMING", maxParticipants: null }) });
        renderPage();

        await screen.findByText("Robotics Club");
        // Auth-first CTA reuses the same disabled-closed treatment as the logged-in Enroll button.
        expect(screen.getByRole("button", { name: /Enrollment Closed \(Upcoming\)/ })).toBeDisabled();
        expect(screen.getByText("Closed")).toBeInTheDocument();
    });

    it("renders optional detail fields when absent or present", async () => {
        setSession({ id: 101 });
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

    it("falls back to a solo household entry when /api/household fails to load", async () => {
        setSession({ id: 777 });
        mockFetchJson({ "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByLabelText("Myself")).toBeInTheDocument();
    });

    it("falls back to a solo household entry when /api/household throws", async () => {
        setSession({ id: 777 });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10")) return { ok: true, status: 200, json: async () => baseProgram({ minAge: null, maxAge: null }) } as Response;
            return Promise.reject(new Error("down"));
        });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByLabelText("Myself")).toBeInTheDocument();
    });

    it("offers household setup when the solo fallback can't clear an age-gated program", async () => {
        setSession({ id: 777 });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/api/programs/10")) return { ok: true, status: 200, json: async () => baseProgram({ participants: [] }) } as Response;
            return Promise.reject(new Error("down"));
        });
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

    it("pre-checks nobody, so the enroll button starts disabled", async () => {
        setSession({ id: 999 });
        mockFetchJson({ "/api/household": household, "/api/programs/10": baseProgram({ minAge: null, maxAge: null }) });
        renderPage();
        await screen.findByText("Robotics Club");
        fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
        expect(await screen.findByLabelText("Kid One")).not.toBeChecked();
        expect(screen.getByLabelText("Too Young")).not.toBeChecked();
        expect(screen.getByRole("button", { name: "Complete Enrollment" })).toBeDisabled();
        expect(screen.getByText("Check the box next to each person you want to enroll.")).toBeInTheDocument();
    });

    // An adult clears a program with no upper age limit, so auto-selecting the
    // signed-in caller would enroll a household lead who came only to pay for a
    // child — stranding an unpaid PENDING row that holds a capacity seat.
    it("does not pre-check the signed-in adult on a program with no upper age limit", async () => {
        setSession({ id: 100, ageBand: 'adult' });
        mockFetchJson({
            "/api/household": household,
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

    it("shows a generic failure message for non-404 program load errors", async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
        renderPage();
        expect(await screen.findByText("Failed to load program details.")).toBeInTheDocument();
    });

    it("shows a network-error message when the program fetch throws", async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error("down"));
        renderPage();
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message: "Network error.", autoClose: false })),
        );
    });

    it("falls back to a bare Not Found card when the program response has no message", async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => null } as Response);
        renderPage();
        expect(await screen.findByText("Not Found")).toBeInTheDocument();
    });
});
