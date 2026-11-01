/**
 * @jest-environment node
 */
import { config, DEV_MOCK_WEBHOOK_SECRET } from "@/lib/config";
import { zohoSign } from "@/lib/membership/contract/zohoProvider";

const ORIGINAL_ENV = { ...process.env };

function setEnv(env: Partial<Record<string, string | undefined>>) {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

const NO_SECRETS = { ZOHO_CLIENT_ID: undefined, ZOHO_CLIENT_SECRET: undefined, ZOHO_REFRESH_TOKEN: undefined };
const ALL_SECRETS = { ZOHO_CLIENT_ID: "cid", ZOHO_CLIENT_SECRET: "csec", ZOHO_REFRESH_TOKEN: "rtok" };

describe("zoho mock fuse (config)", () => {
    beforeEach(() => setEnv({ ...NO_SECRETS, ZOHO_WEBHOOK_SECRET: undefined, CHECKIN_ENV: undefined, NODE_ENV: "test" }));
    afterAll(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("active on dev/local with secrets unset", () => {
        for (const env of ["dev", "local"]) {
            setEnv({ CHECKIN_ENV: env });
            expect(config.zohoMockActive()).toBe(true);
            expect(config.zohoAvailable()).toBe(true);
            expect(config.zohoConfigured()).toBe(false);
            // Dev default webhook secret so the self-fired webhook verifies with zero setup.
            expect(config.zohoWebhookSecret()).toBe(DEV_MOCK_WEBHOOK_SECRET);
        }
    });

    it("dead in prod — no mock, no available, no dev secret", () => {
        setEnv({ CHECKIN_ENV: "prod" });
        expect(config.zohoMockActive()).toBe(false);
        expect(config.zohoAvailable()).toBe(false);
        expect(config.zohoWebhookSecret()).toBeNull();
    });

    it("stays active under a production build on a credless dev instance (NODE_ENV is not a fuse)", () => {
        setEnv({ CHECKIN_ENV: "dev", NODE_ENV: "production" });
        expect(config.zohoMockActive()).toBe(true);
    });

    it("real client wins when secrets are configured in dev", () => {
        setEnv({ CHECKIN_ENV: "dev", ...ALL_SECRETS });
        expect(config.zohoMockActive()).toBe(false);
        expect(config.zohoConfigured()).toBe(true);
        expect(config.zohoAvailable()).toBe(true);
    });
});

describe("mock provider behavior", () => {
    beforeEach(() => setEnv({ ...NO_SECRETS, CHECKIN_ENV: "local", NODE_ENV: "test" }));
    afterAll(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("fabricates ids, points at the dev interstitial, reports completed", async () => {
        expect(await zohoSign.getAccessToken()).toBe("dev-mock-token");

        const created = await zohoSign.createRequest({} as never);
        expect(created.requestId).toMatch(/^dev-req-/);
        expect(created.actionId).toMatch(/^dev-act-/);

        const url = await zohoSign.getEmbeddedSignUrl({
            token: "t",
            requestId: created.requestId,
            actionId: created.actionId,
            host: "http://localhost:4000",
        });
        expect(url).toBe(`http://localhost:4000/dev/zoho-sign?rid=${created.requestId}`);

        expect(await zohoSign.getRequestStatus("t", created.requestId)).toBe("completed");
    });
});
