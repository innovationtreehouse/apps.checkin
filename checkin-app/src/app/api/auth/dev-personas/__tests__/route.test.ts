/**
 * @jest-environment node
 */
/**
 * Gate test for POST /api/auth/dev-personas — the local-only fresh-registrant mint.
 *
 * This route FORGES a brand-new login, so the single security invariant worth proving is:
 * it only works on a local laptop. On cloud 'dev' and on 'prod' it MUST 404 (stricter than
 * the sibling GET, which also serves cloud 'dev'). On 'local' it creates one empty registrant
 * via the real signup helper and returns its id — and never accepts a caller-supplied identity.
 */

import { getServerSession } from "next-auth/next";
import { config, ORG_DOMAIN } from "@/lib/config";
import { createParticipantWithHousehold } from "@/lib/auth-options";

// checkinEnv is the gate input — make it settable per test.
jest.mock("@/lib/config", () => {
    const actual = jest.requireActual("@/lib/config");
    return {
        __esModule: true,
        ...actual,
        config: { ...actual.config, checkinEnv: jest.fn(() => "local") },
    };
});

// jest.setup globally mocks @/lib/auth-options to `{ authOptions: {} }` (no signup helper).
// Add the helper so the local-success path can create without a DB.
jest.mock("@/lib/auth-options", () => ({
    authOptions: {},
    createParticipantWithHousehold: jest.fn(async () => ({ id: 42 })),
}));

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findMany: jest.fn(async () => []) } },
}));

import { GET, POST } from "../route";

const mockCheckinEnv = config.checkinEnv as jest.Mock;
const mockCreate = createParticipantWithHousehold as jest.Mock;
const mockSession = getServerSession as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("POST /api/auth/dev-personas gate", () => {
    it("404s on cloud 'dev'", async () => {
        mockCheckinEnv.mockReturnValue("dev");
        const res = await POST();
        expect(res.status).toBe(404);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("404s on 'prod'", async () => {
        mockCheckinEnv.mockReturnValue("prod");
        const res = await POST();
        expect(res.status).toBe(404);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("mints a server-generated @example.com registrant on 'local'", async () => {
        mockCheckinEnv.mockReturnValue("local");
        const res = await POST();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ personaId: 42 });

        // Identity is server-generated: newfamily+<n>@example.com, never caller-supplied.
        expect(mockCreate).toHaveBeenCalledTimes(1);
        const arg = mockCreate.mock.calls[0][0];
        expect(arg.email).toMatch(/^newfamily\+\d+@example\.com$/);
        expect(arg.name).toMatch(/^New Family \d+$/);
    });
});

describe("GET /api/auth/dev-personas on the deployed dev instance", () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    const ORIGINAL_URL = process.env.NEXTAUTH_URL;
    beforeEach(() => {
        mockCheckinEnv.mockReturnValue("dev");
        process.env.CHECKIN_ENV = "dev";
        process.env.NEXTAUTH_URL = "https://ops-dev.innovationtreehouse.org";
    });
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
        if (ORIGINAL_URL === undefined) delete process.env.NEXTAUTH_URL;
        else process.env.NEXTAUTH_URL = ORIGINAL_URL;
    });
    const req = () => new Request("http://localhost/api/auth/dev-personas");

    it("404s an anonymous caller", async () => {
        mockSession.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(404);
    });

    it("404s a session from a Google account outside the org", async () => {
        mockSession.mockResolvedValue({ user: { id: 2, hd: null, emailVerified: true } });
        expect((await GET(req())).status).toBe(404);
    });

    it("404s an org email whose emailVerified is false", async () => {
        mockSession.mockResolvedValue({ user: { id: 1, hd: ORG_DOMAIN, emailVerified: false } });
        expect((await GET(req())).status).toBe(404);
    });

    it("lists personas for a verified org session, denied or not", async () => {
        mockSession.mockResolvedValue({ user: { id: 1, hd: ORG_DOMAIN, emailVerified: true, denied: true } });
        const res = await GET(req());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ personas: [] });
    });
});
