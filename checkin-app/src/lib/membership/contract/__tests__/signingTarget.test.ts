/**
 * @jest-environment node
 */
/**
 * signingMockActive fuse matrix: the BoardSettings.devSigningTarget radio must
 * only ever be consulted on CHECKIN_ENV=dev with real Zoho creds — prod (and
 * production builds) never read it, and credless non-prod instances stay on the
 * mock unconditionally.
 */
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { boardSettings: { findUnique: jest.fn() } },
}));

import prisma from "@/lib/prisma";
import { signingMockActive } from "@/lib/membership/contract/signingTarget";

const findUnique = (prisma as unknown as { boardSettings: { findUnique: jest.Mock } }).boardSettings.findUnique;

const ORIGINAL_ENV = { ...process.env };

function setEnv(env: Partial<Record<string, string | undefined>>) {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

const NO_SECRETS = { ZOHO_CLIENT_ID: undefined, ZOHO_CLIENT_SECRET: undefined, ZOHO_REFRESH_TOKEN: undefined };
const ALL_SECRETS = { ZOHO_CLIENT_ID: "cid", ZOHO_CLIENT_SECRET: "csec", ZOHO_REFRESH_TOKEN: "rtok" };

beforeEach(() => {
    findUnique.mockReset();
    setEnv({ ...NO_SECRETS, CHECKIN_ENV: undefined, NODE_ENV: "test" });
});

afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
});

describe("signingMockActive", () => {
    it("prod: always real, DB never consulted — even if a row says debug", async () => {
        setEnv({ CHECKIN_ENV: "prod", ...ALL_SECRETS });
        findUnique.mockResolvedValue({ devSigningTarget: "debug" });
        expect(await signingMockActive()).toBe(false);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it("works under a production BUILD on a dev instance (cloud-dev runs the prod image)", async () => {
        // A NODE_ENV fuse would make the radio inert on cloud-dev,
        // whose container sets NODE_ENV=production.
        setEnv({ CHECKIN_ENV: "dev", NODE_ENV: "production", ...ALL_SECRETS });
        findUnique.mockResolvedValue({ devSigningTarget: "debug" });
        expect(await signingMockActive()).toBe(true);
    });

    it("credless dev/local: always mock, DB never consulted (nothing real to call)", async () => {
        for (const env of ["dev", "local"]) {
            setEnv({ CHECKIN_ENV: env });
            expect(await signingMockActive()).toBe(true);
        }
        expect(findUnique).not.toHaveBeenCalled();
    });

    it("dev with creds: the radio picks — 'debug' routes to the mock", async () => {
        setEnv({ CHECKIN_ENV: "dev", ...ALL_SECRETS });
        findUnique.mockResolvedValue({ devSigningTarget: "debug" });
        expect(await signingMockActive()).toBe(true);
    });

    it("dev with creds: 'zoho', null, or no row all mean the real client", async () => {
        setEnv({ CHECKIN_ENV: "dev", ...ALL_SECRETS });
        for (const row of [{ devSigningTarget: "zoho" }, { devSigningTarget: null }, null]) {
            findUnique.mockResolvedValue(row);
            expect(await signingMockActive()).toBe(false);
        }
    });

    it("local with creds: real client — the DB override is dev-instance-only", async () => {
        setEnv({ CHECKIN_ENV: "local", ...ALL_SECRETS });
        findUnique.mockResolvedValue({ devSigningTarget: "debug" });
        expect(await signingMockActive()).toBe(false);
        expect(findUnique).not.toHaveBeenCalled();
    });
});
