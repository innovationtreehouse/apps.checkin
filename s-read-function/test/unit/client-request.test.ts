/**
 * The Shopify client's retry/throttle control loop (createShopifyClient.request).
 *
 * The pure wait-math helpers are covered in backoff.test.ts; this file exercises the
 * `while(true)` loop that wires them together against a stubbed global `fetch`:
 * which responses retry, which throw, that Retry-After is honored, that THROTTLED
 * waits per the cost formula, and that MAX_ATTEMPTS is enforced.
 *
 * `setTimeout` is stubbed to record the requested delay and fire synchronously, so
 * the real backoff durations are asserted without any real waiting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShopifyClient, MAX_ATTEMPTS, REQUEST_TIMEOUT_MS } from "../../src/shopify/client.js";
import type { ShopifyConfig } from "@checkin/s-ingest-core";

// Silence the retry warn/info logs and avoid pulling the generated Prisma client in.
vi.mock("@checkin/s-ingest-core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const cfg = { endpoint: "https://shop.myshopify.com/admin/api/2025-07/graphql.json", adminToken: "shpat_test" } as ShopifyConfig;

/** Build a fetch-`Response` test double. */
function resp(opts: { status?: number; body?: unknown; retryAfter?: string; text?: string }) {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null) },
    json: async () => opts.body ?? {},
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

const ok = (data: unknown) => resp({ body: { data } });
const throttled = (cost?: unknown) =>
  resp({ body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost } } });

let sleeps: number[];

beforeEach(() => {
  sleeps = [];
  // Record the delay and resolve immediately so retries don't actually wait. Leave the
  // per-attempt abort timer (REQUEST_TIMEOUT_MS) pending — firing it would abort every
  // request. The dedicated timeout test below re-stubs to fire it.
  vi.stubGlobal("setTimeout", ((cb: () => void, ms: number) => {
    if (ms === REQUEST_TIMEOUT_MS) return 0 as unknown as ReturnType<typeof setTimeout>;
    sleeps.push(ms);
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createShopifyClient.request — happy path", () => {
  it("returns data and sends auth header + endpoint on the first try", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ shop: { id: "1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createShopifyClient(cfg);
    const data = await client.request<{ shop: { id: string } }>("query {}", { a: 1 });

    expect(data).toEqual({ shop: { id: "1" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]); // no retry, no sleep
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(cfg.endpoint);
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_test");
    expect(JSON.parse(init.body as string)).toEqual({ query: "query {}", variables: { a: 1 } });
  });
});

describe("createShopifyClient.request — transient retries then success", () => {
  it("retries a 500 then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp({ status: 500 })).mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await createShopifyClient(cfg).request("q");
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1); // backed off once
  });

  it("retries a 429 and honors Retry-After (seconds → ms) over jittered backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp({ status: 429, retryAfter: "2" }))
      .mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyClient(cfg).request("q");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]); // exactly the Retry-After, not random jitter
  });

  it("retries a network error (fetch rejects) then succeeds", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await createShopifyClient(cfg).request("q");
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits per Shopify's cost formula on a THROTTLED GraphQL error, then succeeds", async () => {
    // deficit 900 / 50 per s = 18s = 18000ms (+250 buffer)
    const cost = { requestedQueryCost: 1000, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } };
    const fetchMock = vi.fn().mockResolvedValueOnce(throttled(cost)).mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyClient(cfg).request("q");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([18_000 + 250]);
  });
});

describe("createShopifyClient.request — exhaustion and hard failures", () => {
  it("throws after MAX_ATTEMPTS of 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow(`failed after ${MAX_ATTEMPTS} attempts: HTTP 503`);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sleeps).toHaveLength(MAX_ATTEMPTS - 1); // no sleep after the final attempt
  });

  it("rethrows the original error when the network keeps failing", async () => {
    const boom = new Error("ENOTFOUND");
    const fetchMock = vi.fn().mockRejectedValue(boom);
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("throws after MAX_ATTEMPTS of THROTTLED", async () => {
    const fetchMock = vi.fn().mockResolvedValue(throttled());
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow(`throttled after ${MAX_ATTEMPTS} attempts`);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("throws immediately on a non-retryable 4xx (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ status: 400, text: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow("HTTP 400 Bad Request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("still throws a clean error when reading the 4xx body fails (safeText swallows it)", async () => {
    const brokenBody = {
      status: 400,
      ok: false,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => {
        throw new Error("stream already consumed");
      },
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(brokenBody);
    vi.stubGlobal("fetch", fetchMock);

    // safeText returns "" rather than masking the real status with its own throw.
    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow("HTTP 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-throttle GraphQL errors without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ body: { errors: [{ message: "Field 'x' doesn't exist" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow("Shopify GraphQL error: Field 'x' doesn't exist");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the response carries neither data nor errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ body: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow("no data");
  });

  it("aborts a hung connection per attempt and throws a timeout error after MAX_ATTEMPTS", async () => {
    // The stubbed setTimeout fires the abort callback synchronously, so the per-attempt
    // deadline trips immediately. A fetch that only settles on abort stands in for a hung
    // TCP connection — it must retry, not run to the Lambda timeout.
    // Fire every timer synchronously here, including the per-attempt abort timer.
    vi.stubGlobal("setTimeout", ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("q")).rejects.toThrow(
      `Shopify request timed out after ${REQUEST_TIMEOUT_MS}ms (${MAX_ATTEMPTS} attempts)`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });
});
