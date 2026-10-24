import { buildQuickBooks, lambdaAccessTokenSource } from "../client";

jest.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }));

const SANDBOX = "1111";
const PROD = "9999";
const MIN = 60_000;

const answer = (over: Record<string, unknown> = {}) => ({
    accessToken: "tok-1",
    expiresAt: 60 * MIN,
    realmId: SANDBOX,
    clientId: "dev-id",
    ...over,
});

const source = (invoke: jest.Mock, now: () => number = () => 0, checkinEnv = "dev") =>
    lambdaAccessTokenSource({ functionName: "qbo-refresher", realmId: SANDBOX, checkinEnv, devClientId: "dev-id", invoke, now });

describe("lambdaAccessTokenSource", () => {
    it("caches the token until five minutes before expiry", async () => {
        let t = 0;
        const invoke = jest.fn().mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer({ accessToken: "tok-2", expiresAt: 120 * MIN }));
        const tokens = source(invoke, () => t);
        expect(await tokens.current()).toBe("tok-1");
        t = 54 * MIN;
        expect(await tokens.current()).toBe("tok-1");
        t = 55 * MIN;
        expect(await tokens.current()).toBe("tok-2");
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it("shares one refresher call between concurrent callers", async () => {
        const invoke = jest.fn().mockResolvedValue(answer());
        const tokens = source(invoke);
        await Promise.all([tokens.current(), tokens.current(), tokens.current()]);
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("refuses an answer for another realm", async () => {
        await expect(source(jest.fn().mockResolvedValue(answer({ realmId: PROD }))).current()).rejects.toThrow(/different realm/);
    });

    it("refuses production keys off prod and development keys on prod", async () => {
        await expect(source(jest.fn().mockResolvedValue(answer({ clientId: "prod-id" }))).current()).rejects.toThrow(/development keys/);
        await expect(source(jest.fn().mockResolvedValue(answer()), () => 0, "prod").current()).rejects.toThrow(/refuses the development/);
    });

    it("refuses a malformed answer and retries on the next call", async () => {
        const invoke = jest.fn().mockResolvedValueOnce({ accessToken: "" }).mockResolvedValueOnce(answer());
        const tokens = source(invoke);
        await expect(tokens.current()).rejects.toThrow(/malformed/);
        expect(await tokens.current()).toBe("tok-1");
    });
});

describe("buildQuickBooks", () => {
    const env = (vars: Record<string, string | undefined>) => {
        for (const [k, v] of Object.entries(vars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    const saved = { ...process.env };
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        env({
            CHECKIN_ENV: "dev",
            QBO_ENVIRONMENT: "sandbox",
            QBO_REALM_ID: SANDBOX,
            QBO_SANDBOX_REALM_ALLOWED: SANDBOX,
            QBO_REFRESHER_FN: "qbo-refresher",
            QBO_DEV_CLIENT_ID: "dev-id",
        });
    });
    afterEach(() => {
        process.env = { ...saved };
        errorSpy.mockRestore();
        jest.clearAllMocks();
    });

    it("builds a sandbox client off prod", async () => {
        expect(await buildQuickBooks()).not.toBeNull();
    });

    it("is off with no realm configured", async () => {
        env({ QBO_REALM_ID: undefined });
        expect(await buildQuickBooks()).toBeNull();
    });

    it("is off when the guard refuses, and says why", async () => {
        env({ QBO_SANDBOX_REALM_ALLOWED: "2222" });
        expect(await buildQuickBooks()).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith("QuickBooks is off:", expect.stringMatching(/allowlisted/));
    });

    it("is inert on stg with no QBO env", async () => {
        env({ CHECKIN_ENV: "stg", QBO_ENVIRONMENT: undefined, QBO_REALM_ID: undefined, QBO_SANDBOX_REALM_ALLOWED: undefined, QBO_REFRESHER_FN: undefined });
        expect(await buildQuickBooks()).toBeNull();
    });

    it("is off on stg even when configured like dev", async () => {
        env({ CHECKIN_ENV: "stg" });
        expect(await buildQuickBooks()).toBeNull();
    });

    it("on prod, reaches the configured realm only through the production API", async () => {
        env({ CHECKIN_ENV: "prod", QBO_ENVIRONMENT: "production", QBO_REALM_ID: PROD, QBO_SANDBOX_REALM_ALLOWED: undefined });
        expect(await buildQuickBooks()).not.toBeNull();
        env({ QBO_ENVIRONMENT: "sandbox" });
        expect(await buildQuickBooks()).toBeNull();
    });

    it("is off with no token source", async () => {
        env({ QBO_REFRESHER_FN: undefined });
        expect(await buildQuickBooks()).toBeNull();
    });
});
