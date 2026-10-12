/**
 * @jest-environment node
 */
import {
    getAccessToken,
    createRequest,
    getEmbeddedSignUrl,
    getRequestStatus,
    recallRequest,
    ZohoError,
    _resetTokenCache,
} from "@/lib/membership/contract/zohoClient";

const ORIGINAL_ENV = { ...process.env };

function mockFetchOnce(body: unknown, ok = true, status = 200) {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });
}

describe("zohoClient", () => {
    beforeEach(() => {
        process.env.ZOHO_CLIENT_ID = "cid";
        process.env.ZOHO_CLIENT_SECRET = "csecret";
        process.env.ZOHO_REFRESH_TOKEN = "rtoken";
        delete process.env.ZOHO_ACCOUNTS_URL;
        delete process.env.ZOHO_SIGN_API;
        _resetTokenCache();
        global.fetch = jest.fn();
    });
    afterAll(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("caches the access token across calls (one token exchange)", async () => {
        mockFetchOnce({ access_token: "tok-123", expires_in: 3600 });
        const a = await getAccessToken();
        const b = await getAccessToken();
        expect(a).toBe("tok-123");
        expect(b).toBe("tok-123");
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("throws ZohoError when OAuth secrets are missing", async () => {
        delete process.env.ZOHO_REFRESH_TOKEN;
        await expect(getAccessToken()).rejects.toBeInstanceOf(ZohoError);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("createRequest returns request/action/document ids on success", async () => {
        mockFetchOnce({
            status: "success",
            requests: {
                request_id: "req-1",
                actions: [{ action_id: "act-1" }],
                document_ids: [{ document_id: "doc-1" }],
            },
        });
        const result = await createRequest({
            token: "t",
            pdf: Buffer.from("%PDF-1.4 fake"),
            filename: "a.pdf",
            recipientEmail: "x@example.com",
            recipientName: "X",
            requestName: "Agreement",
            expirationDays: 15,
            redirectPages: {
                sign_completed: "https://app.example.com/membership?signed=1",
                sign_success: "https://app.example.com/membership?signed=1",
                sign_declined: "https://app.example.com/membership?declined=1",
                sign_later: "https://app.example.com/membership",
            },
        });
        expect(result).toEqual({ requestId: "req-1", actionId: "act-1", documentId: "doc-1" });
        // redirect_pages must ride in the create payload so the embedded signer is
        // returned to checkin after signing (not stranded on Zoho's page).
        const sentData = JSON.parse(
            ((global.fetch as jest.Mock).mock.calls[0][1].body as FormData).get("data") as string,
        );
        expect(sentData.requests.redirect_pages.sign_completed).toContain("/membership?signed=1");
    });

    it("createRequest throws when Zoho reports a non-success status", async () => {
        mockFetchOnce({ status: "failure", message: "nope" });
        await expect(
            createRequest({
                token: "t",
                pdf: Buffer.from("x"),
                filename: "a.pdf",
                recipientEmail: "x@example.com",
                recipientName: "X",
                requestName: "Agreement",
                expirationDays: 15,
                redirectPages: {
                    sign_completed: "https://app.example.com/membership?signed=1",
                    sign_success: "https://app.example.com/membership?signed=1",
                    sign_declined: "https://app.example.com/membership?declined=1",
                    sign_later: "https://app.example.com/membership",
                },
            }),
        ).rejects.toBeInstanceOf(ZohoError);
    });

    it("getEmbeddedSignUrl returns the sign_url and passes host", async () => {
        mockFetchOnce({ sign_url: "https://sign.zoho.com/embed/abc" });
        const url = await getEmbeddedSignUrl({ token: "t", requestId: "req-1", actionId: "act-1", host: "https://app.example.com" });
        expect(url).toBe("https://sign.zoho.com/embed/abc");
        const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
        expect(calledUrl.toString()).toContain("/requests/req-1/actions/act-1/embedtoken");
        expect(calledUrl.searchParams.get("host")).toBe("https://app.example.com");
    });

    it("getRequestStatus normalizes completed / in-flight / dead request states", async () => {
        mockFetchOnce({ requests: { request_status: "completed" } });
        await expect(getRequestStatus("t", "req-1")).resolves.toBe("completed");

        mockFetchOnce({ requests: { request_status: "inprogress" } });
        await expect(getRequestStatus("t", "req-1")).resolves.toBe("in_progress");

        // Declined and expired requests can never be signed — they must surface as
        // terminal so the caller creates a fresh request (#876).
        for (const dead of ["declined", "expired", "recalled"]) {
            mockFetchOnce({ requests: { request_status: dead } });
            await expect(getRequestStatus("t", "req-1")).resolves.toBe("terminal");
        }
    });

    it("recallRequest POSTs /requests/{id}/recall and surfaces a failure as ZohoError", async () => {
        mockFetchOnce({ code: 0, status: "success", message: "Document has been recalled" });
        await expect(recallRequest("t", "req-1")).resolves.toBeUndefined();
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe("https://sign.zoho.com/api/v1/requests/req-1/recall");
        expect(init.method).toBe("POST");

        mockFetchOnce({ code: 4003, status: "failure" }, false, 400);
        await expect(recallRequest("t", "req-1")).rejects.toBeInstanceOf(ZohoError);
    });

    it("rejects with a ZohoError timeout when the connection hangs (never resolves)", async () => {
        // Drive the deadline manually: the per-request AbortSignal.timeout is replaced with a
        // controller we fire ourselves, standing in for the timeout elapsing. The fetch only
        // settles on abort — a hung TCP connection that would otherwise never resolve.
        const deadline = new AbortController();
        const timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        (global.fetch as jest.Mock).mockImplementation(
            (_url, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    const signal = init.signal as AbortSignal;
                    signal.addEventListener("abort", () => reject(signal.reason));
                }),
        );

        const p = getAccessToken();
        deadline.abort(new DOMException("The operation timed out", "TimeoutError"));
        await expect(p).rejects.toThrow(/Zoho token exchange timed out after 20000ms/);
        timeoutSpy.mockRestore();
    });
});
