/**
 * @jest-environment node
 */
import { kindOf } from "@checkin/component-kit";
import { invokeRefresher } from "../tokenRefresher";

const send = jest.fn();
jest.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: jest.fn(() => ({ send })), InvokeCommand: jest.fn() }));

const call = { functionName: "test-refresher", service: "Test token refresher", reconnect: "Test needs reconnecting.", malformed: "Test settings are wrong." };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const failure = (body: unknown) => ({ FunctionError: "Unhandled", Payload: bytes(body) });

beforeEach(() => send.mockReset());

describe("invokeRefresher", () => {
    it("returns the parsed answer", async () => {
        send.mockResolvedValue({ Payload: bytes({ accessToken: "tok" }) });
        await expect(invokeRefresher(call)).resolves.toEqual({ accessToken: "tok" });
    });

    it("is connection, with the reconnect message, when the refresher answers ReconsentRequired", async () => {
        send.mockResolvedValue(failure({ errorType: "ReconsentRequired", errorMessage: "refresh token rejected" }));
        const err = await invokeRefresher(call).catch((e: unknown) => e);
        expect(kindOf(err)).toBe("connection");
        expect((err as Error).message).toBe("Test needs reconnecting.");
    });

    it("is system for a refresher that predates ReconsentRequired, and never echoes its message", async () => {
        send.mockResolvedValue(failure({ errorType: "Error", errorMessage: "token request failed 400: invalid_grant" }));
        const err = await invokeRefresher(call).catch((e: unknown) => e);
        expect(kindOf(err)).toBe("system");
        expect((err as Error).message).toBe("Test token refresher test-refresher failed");
    });

    it("is system when the error payload is unreadable", async () => {
        send.mockResolvedValue({ FunctionError: "Unhandled", Payload: new TextEncoder().encode("not json") });
        expect(kindOf(await invokeRefresher(call).catch((e: unknown) => e))).toBe("system");
    });

    it("is settings, with the malformed message, when the answer is not JSON", async () => {
        send.mockResolvedValue({ Payload: new TextEncoder().encode("<html>not a refresher</html>") });
        const err = await invokeRefresher(call).catch((e: unknown) => e);
        expect(kindOf(err)).toBe("settings");
        expect((err as Error).message).toBe("Test settings are wrong.");
    });

    it("is system when the invocation itself fails", async () => {
        send.mockRejectedValue(new Error("network down"));
        expect(kindOf(await invokeRefresher(call).catch((e: unknown) => e))).toBe("system");
    });
});
