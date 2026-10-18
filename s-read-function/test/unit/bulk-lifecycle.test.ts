/**
 * The Shopify bulk-operation lifecycle calls in bulk.ts: starting an export
 * (success, the "already running" userError, and the no-operation response), polling an op by id, and
 * downloading the JSONL (success + HTTP error). reassembly itself is covered in
 * bulk-reassemble.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { startOrdersBackfill, getBulkOperation, downloadBulkJsonl } from "../../src/shopify/bulk.js";
import { fakeClient } from "../helpers/fakeClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("startOrdersBackfill", () => {
  it("returns the bulk operation and forwards the cutover-scoped query", async () => {
    const client = fakeClient({ bulkOperationRunQuery: { bulkOperation: { id: "gid://op/1", status: "CREATED" }, userErrors: [] } });
    const op = await startOrdersBackfill(client, "2026-01-01T00:00:00.000Z");

    expect(op).toEqual({ id: "gid://op/1", status: "CREATED" });
    expect(client.calls[0].variables.query).toContain("2026-01-01T00:00:00.000Z");
  });

  it("throws when Shopify returns userErrors", async () => {
    const client = fakeClient({
      bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ field: ["query"], message: "A bulk query is already running" }] },
    });
    await expect(startOrdersBackfill(client, "2026-01-01")).rejects.toThrow("A bulk query is already running");
  });

  it("throws when no operation is returned and there are no userErrors", async () => {
    const client = fakeClient({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [] } });
    await expect(startOrdersBackfill(client, "2026-01-01")).rejects.toThrow("returned no operation");
  });
});

describe("getBulkOperation", () => {
  it("polls bulkOperation(id:) with the tracked id, not the deprecated currentBulkOperation", async () => {
    const client = fakeClient({ bulkOperation: { id: "gid://op/9", status: "RUNNING", objectCount: "12" } });
    expect(await getBulkOperation(client, "gid://op/9")).toEqual({ id: "gid://op/9", status: "RUNNING", objectCount: "12" });
    expect(client.calls[0].variables).toEqual({ id: "gid://op/9" });
    expect(client.calls[0].query).toContain("bulkOperation(id: $id)");
    expect(client.calls[0].query).not.toContain("currentBulkOperation");
  });

  it.each([
    { id: "gid://op/9", status: "COMPLETED", url: "https://storage.googleapis.com/r.jsonl", errorCode: null },
    { id: "gid://op/9", status: "FAILED", url: null, errorCode: "INTERNAL_SERVER_ERROR" },
    { id: "gid://op/9", status: "CANCELED", url: null, errorCode: null },
  ])("returns the $status operation as Shopify reports it", async (op) => {
    expect(await getBulkOperation(fakeClient({ bulkOperation: op }), "gid://op/9")).toEqual(op);
  });

  it("returns null when Shopify no longer knows the id", async () => {
    expect(await getBulkOperation(fakeClient({ bulkOperation: null }), "gid://op/9")).toBeNull();
  });
});

describe("downloadBulkJsonl", () => {
  it("returns the body text on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "line1\nline2\n" }));
    expect(await downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/result.jsonl")).toBe("line1\nline2\n");
  });

  it("accepts an allowlisted https GCS host without rejecting", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok\n" });
    vi.stubGlobal("fetch", fetchMock);
    expect(await downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/r.jsonl")).toBe("ok\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects SSRF targets (http, metadata IP, arbitrary host, suffix-spoof) before any fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const url of [
      "http://storage.googleapis.com/shopify-bulk/r.jsonl", // not https
      "https://169.254.169.254/latest/meta-data/", // cloud metadata service
      "https://evil.example.com/r.jsonl", // off-allowlist host
      "https://storage.googleapis.com.evil.com/r.jsonl", // suffix-spoof
    ]) {
      await expect(downloadBulkJsonl(url, { backoffMs: () => 0 })).rejects.toThrow(/rejected/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a redirect off the signed URL (redirect: manual), no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ type: "opaqueredirect", ok: false, status: 0, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/r.jsonl", { backoffMs: () => 0 }),
    ).rejects.toThrow("redirect blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("throws immediately on a non-retryable status (403 expired signed URL), no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/result.jsonl", { backoffMs: () => 0 })).rejects.toThrow("HTTP 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 5xx then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "ok\n" });
    vi.stubGlobal("fetch", fetchMock);

    expect(await downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/r.jsonl", { backoffMs: () => 0 })).toBe("ok\n");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an abort/timeout (AbortError) then succeeds", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "late\n" });
    vi.stubGlobal("fetch", fetchMock);

    expect(await downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/r.jsonl", { backoffMs: () => 0 })).toBe("late\n");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts on a persistent transient failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/r.jsonl", { maxAttempts: 3, backoffMs: () => 0 }),
    ).rejects.toThrow("HTTP 500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts a hung download after timeoutMs (the AbortController actually fires)", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      // A fetch that never resolves on its own — only settles when the timeout aborts it.
      const fetchMock = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
        signal = opts.signal;
        return new Promise((_res, rej) => {
          opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const p = downloadBulkJsonl("https://storage.googleapis.com/shopify-bulk/r.jsonl", { timeoutMs: 1_000, maxAttempts: 1, backoffMs: () => 0 });
      const rejects = expect(p).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejects;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
