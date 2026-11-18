// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { signIn } from "next-auth/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import Home from "../page";

const violating = { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: true };

beforeEach(() => resetRtl());

describe("Home", () => {
    it("offers Google sign-in when signed out", () => {
        renderWithProviders(<Home />);

        fireEvent.click(screen.getByRole("button", { name: /sign in to dashboard/i }));

        expect(signIn).toHaveBeenCalledWith("google");
    });

    it("offers no check-in or check-out: people badge at the kiosk", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();

        expect(screen.queryByRole("button", { name: /check (in|out)/i })).not.toBeInTheDocument();
    });

    it("warns of a two-deep violation while the kiosk is reachable", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();
    });

    it("says it can't confirm instead of stating a violation when the kiosk is unreachable", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: false, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText("Can't confirm building state")).toBeInTheDocument();
        expect(screen.queryByText(/Two-Deep Compliance is failing/)).not.toBeInTheDocument();
    });
});

describe("failed safety check", () => {
    it("says the check could not run, and Retry shows the warning it was hiding", async () => {
        setSession({ id: 1, name: "Kay Keyholder", isKeyholder: true });
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const failed = String(input).includes("/api/attendance");
            const body = failed ? {} : { membershipStatus: "ACTIVE" };
            return { ok: !failed, status: failed ? 500 : 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
        }) as unknown as typeof fetch;
        renderWithProviders(<Home />);

        expect(await screen.findByText("Couldn't load the building safety check")).toBeInTheDocument();

        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();
        expect(screen.queryByText("Couldn't load the building safety check")).not.toBeInTheDocument();
    });
});

describe("safety answer without its flags", () => {
    it("says the safety result is missing instead of reading it as all-clear, and Retry shows the warning", async () => {
        setSession({ id: 1, name: "Kay Keyholder", isKeyholder: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: {}, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);

        expect(await screen.findByText(/came back without the safety result/)).toBeInTheDocument();
        expect(screen.getByText("Couldn't load the building safety check")).toBeInTheDocument();

        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();
        expect(screen.queryByText(/came back without the safety result/)).not.toBeInTheDocument();
    });
});

describe("failed membership read", () => {
    it("says the membership status could not load instead of hiding the join banner, and Retry shows it", async () => {
        setSession({ id: 1, name: "Val Visitor" });
        let membershipFails = true;
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const failed = membershipFails && url.includes("/api/membership");
            const body = failed
                ? { error: "Forbidden" }
                : url.includes("/api/membership")
                    ? { membershipStatus: null, process: null }
                    : { access: "full", attendance: [], safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false }, building: { reachable: true, lastSeenAt: null } };
            return { ok: !failed, status: failed ? 403 : 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
        }) as unknown as typeof fetch;
        const { container } = renderWithProviders(<Home />);

        expect(await screen.findByText("Couldn't load your membership status")).toBeInTheDocument();
        expect(container.querySelector('a[href="/membership"]')).toBeNull();

        membershipFails = false;
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(container.querySelector('a[href="/membership"]')).not.toBeNull());
        expect(screen.queryByText("Couldn't load your membership status")).not.toBeInTheDocument();
    });
});

describe("cached safety check", () => {
    it("shows the warning from this visit's own read, not an older cached all-clear", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false }, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        const earlier = renderWithProviders(<Home />);
        expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();
        earlier.unmount();

        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        renderWithProviders(<Home />);
        expect(await screen.findByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();
    });

    it("keeps a cached warning and says it is still checking until this visit's read answers", async () => {
        setSession({ id: 1, name: "Ann Admin", isSysadmin: true });
        mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: violating, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        const earlier = renderWithProviders(<Home />);
        expect(await screen.findByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();
        earlier.unmount();

        const answer = mockFetchJson({
            "/api/attendance": { access: "full", attendance: [], safety: { facilityOpen: true, isLastKeyholder: false, isTwoDeepViolation: false }, building: { reachable: true, lastSeenAt: null } },
            "/api/membership": { membershipStatus: "ACTIVE" },
        });
        const held: Array<() => void> = [];
        let released = false;
        global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => released
            ? answer(input, init)
            : new Promise<Response>((resolve) => { held.push(() => resolve(answer(input, init))); })) as unknown as typeof fetch;
        renderWithProviders(<Home />);

        expect(await screen.findByText("Checking building safety…")).toBeInTheDocument();
        expect(screen.getByText(/Two-Deep Compliance is failing/)).toBeInTheDocument();

        released = true;
        held.forEach((release) => release());
        await waitFor(() => expect(screen.queryByText("Checking building safety…")).not.toBeInTheDocument());
        expect(screen.queryByText(/Two-Deep Compliance is failing/)).not.toBeInTheDocument();
    });
});
