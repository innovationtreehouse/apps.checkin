/**
 * The dev CLI (`npm run ping|read-*|sync:*|inject`). cli.ts runs main() on import, so each
 * case sets process.argv, imports the module fresh, and flushes the floating
 * main().catch().finally() chain before asserting. The Shopify client, the s-ingest-core
 * surface, and the handler are mocked; this isolates command dispatch, the `--limit`
 * parser, email masking, the no-payments-account branch, the inject usage guard, and the
 * always-runs $disconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  request: vi.fn(),
  handler: vi.fn(),
  injectFile: vi.fn(),
  loadDbConfig: vi.fn(),
  loadShopifyConfig: vi.fn(),
  disconnect: vi.fn(),
  findStore: vi.fn(),
  withSyncRun: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@inventory/s-ingest-core", () => ({
  prisma: { $disconnect: m.disconnect, store: { findUnique: m.findStore } },
  loadDbConfig: m.loadDbConfig,
  loadShopifyConfig: m.loadShopifyConfig,
  injectFile: m.injectFile,
  withSyncRun: m.withSyncRun,
  SyncKind: { ADMIN: "ADMIN" },
  PROD_STORE_DOMAIN: "prod.myshopify.com",
  logger: m.logger,
}));
vi.mock("../../src/handler.js", () => ({ handler: m.handler, armSyncDeadline: vi.fn() }));
vi.mock("../../src/shopify/client.js", () => ({
  createShopifyClient: vi.fn(() => ({ request: m.request, endpoint: "https://shop/graphql.json" })),
}));

const origArgv = process.argv;

beforeEach(() => {
  vi.clearAllMocks();
  m.loadShopifyConfig.mockReturnValue({ endpoint: "https://shop/graphql.json", apiVersion: "2025-07", adminToken: "t" });
  m.loadDbConfig.mockReturnValue({ storeId: "s1" });
  m.disconnect.mockResolvedValue(undefined);
  m.findStore.mockResolvedValue(null);
  m.withSyncRun.mockImplementation((_p, _s, _k, _scope, fn) => fn(77n));
  process.env.INJECT_ALLOW = "1";
  process.exitCode = undefined;
});

afterEach(() => {
  delete process.env.INJECT_ALLOW;
  process.argv = origArgv;
  process.exitCode = undefined;
});

async function runCli(args: string[]): Promise<void> {
  process.argv = ["node", "cli.ts", ...args];
  vi.resetModules();
  await import("../../src/cli.js");
  await new Promise((r) => setImmediate(r));
}

/** Find the payload a logger call carried, by its message. */
const logged = (msg: string) => m.logger.info.mock.calls.find((c) => c[0] === msg)?.[1] as Record<string, unknown>;

describe("cli — connectivity & read probes", () => {
  it("ping: requests the shop identity and logs ok", async () => {
    m.request.mockResolvedValue({ shop: { name: "Shop", myshopifyDomain: "shop.myshopify.com", currencyCode: "USD", ianaTimezone: "UTC" } });

    await runCli(["ping"]);

    expect(m.request).toHaveBeenCalledOnce();
    expect(logged("shopify ping ok")).toMatchObject({ apiVersion: "2025-07" });
    expect(process.exitCode).toBeUndefined();
  });

  it("read-orders: honors --limit, masks the customer email, and tolerates missing email", async () => {
    m.request.mockResolvedValue({
      orders: {
        edges: [
          { node: { id: "gid://x/Order/1", email: "jane@example.com", customer: { email: "jane@example.com", displayName: "Jane" } } },
          { node: { id: "gid://x/Order/2", email: null, customer: null } },
        ],
      },
    });

    await runCli(["read-orders", "--limit", "2"]);

    expect(m.request.mock.calls[0][1]).toEqual({ first: 2, query: "status:any" });
    const payload = logged("read orders ok");
    expect(payload).toMatchObject({ requested: 2, returned: 2 });
    const orders = payload.orders as Array<Record<string, unknown>>;
    expect(orders[0].customerEmail).toBe("j***@example.com");
    expect(orders[0].customerNamePresent).toBe(true);
    expect(orders[1].customerEmail).toBeNull();
  });

  it("read-orders: `--limit=N` form parses too; a non-numeric value falls back", async () => {
    m.request.mockResolvedValue({ orders: { edges: [] } });

    await runCli(["read-orders", "--limit=bogus"]);

    // Number("bogus") || fallback → 1
    expect(m.request.mock.calls[0][1]).toEqual({ first: 1, query: "status:any" });
  });

  it("read-payouts: warns and stops when the store has no Shopify Payments account", async () => {
    m.request.mockResolvedValue({ shopifyPaymentsAccount: null });

    await runCli(["read-payouts"]);

    expect(m.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no shopifyPaymentsAccount"), {});
    expect(m.logger.info).not.toHaveBeenCalledWith("read payouts ok", expect.anything());
  });

  it("read-payouts: logs the payout summary when an account is present", async () => {
    m.request.mockResolvedValue({
      shopifyPaymentsAccount: {
        payouts: {
          edges: [{ node: { id: "po1", issuedAt: "2026-03-01", status: "paid", net: { amount: "10.00", currencyCode: "USD" } } }],
        },
      },
    });

    await runCli(["read-payouts"]);

    const payload = logged("read payouts ok");
    expect(payload).toMatchObject({ returned: 1 });
    expect((payload.payouts as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "po1", net: "10.00" });
  });

  it("read-balance-txns: warns and stops when there is no Shopify Payments account", async () => {
    m.request.mockResolvedValue({ shopifyPaymentsAccount: null });

    await runCli(["read-balance-txns"]);

    expect(m.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no shopifyPaymentsAccount"), {});
    expect(m.logger.info).not.toHaveBeenCalledWith("read balance txns ok", expect.anything());
  });

  it("read-balance-txns: logs the bridge-field summary when an account is present", async () => {
    m.request.mockResolvedValue({
      shopifyPaymentsAccount: {
        balanceTransactions: {
          edges: [{ node: { id: "bt1", type: "charge", associatedOrder: { id: "gid://x/Order/1", name: "#1" } } }],
        },
      },
    });

    await runCli(["read-balance-txns"]);

    const payload = logged("read balance txns ok");
    expect(payload).toMatchObject({ returned: 1, withOrder: 1 });
  });
});

describe("cli — sync orchestrators", () => {
  it("incremental: delegates to the handler with mode=incremental", async () => {
    m.handler.mockResolvedValue({ orders: 5, payouts: 0, balanceTransactions: 0 });

    await runCli(["incremental"]);

    expect(m.handler).toHaveBeenCalledWith({ mode: "incremental" });
    expect(logged("incremental sync done")).toMatchObject({ orders: 5 });
  });

  it("backfill: delegates to the handler with mode=backfill", async () => {
    m.handler.mockResolvedValue({ ordersBulk: { action: "STARTED" }, payouts: 0, balanceTransactions: 0 });

    await runCli(["backfill"]);

    expect(m.handler).toHaveBeenCalledWith({ mode: "backfill" });
  });
});

describe("cli — inject & guard rails", () => {
  /** The error main() rejected with, via the top-level catch. */
  const cliError = () => (m.logger.error.mock.calls.find((c) => c[0] === "cli failed")?.[1] as { err: Error }).err;

  it("inject: runs inside an attributed ADMIN sync_run and logs an inserted/total summary", async () => {
    m.injectFile.mockResolvedValue([
      { inserted: true, shopifyGid: "g1" },
      { inserted: false, shopifyGid: "g2" },
    ]);

    await runCli(["inject", "--reason", "historical CSV load", "fixtures/orders.json"]);

    expect(m.withSyncRun).toHaveBeenCalledWith(expect.anything(), "s1", "ADMIN", "inject", expect.any(Function), {
      actor: expect.stringMatching(/^cli:/),
      reason: "historical CSV load",
    });
    expect(m.injectFile).toHaveBeenCalledWith(expect.anything(), "fixtures/orders.json", {
      storeId: "s1",
      test: false,
      syncRunId: 77n,
    });
    expect(logged("inject done")).toMatchObject({ count: 2, inserted: 1, source: "HAND_LOADED", reason: "historical CSV load" });
  });

  it("inject --test: marks the source TEST_LOADED", async () => {
    m.injectFile.mockResolvedValue([]);

    await runCli(["inject", "fixtures/t.json", "--test", "--reason=dev fixture"]);

    expect(m.injectFile).toHaveBeenCalledWith(expect.anything(), "fixtures/t.json", { storeId: "s1", test: true, syncRunId: 77n });
    expect(logged("inject done")).toMatchObject({ source: "TEST_LOADED" });
  });

  it("inject without a file path fails with a usage error (exitCode 1)", async () => {
    await runCli(["inject", "--test"]);

    expect(m.injectFile).not.toHaveBeenCalled();
    expect(cliError().message).toMatch(/Usage/);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["without INJECT_ALLOW=1", ["inject", "f.json", "--reason", "x"], () => delete process.env.INJECT_ALLOW, /INJECT_ALLOW/],
    ["without --reason", ["inject", "f.json"], () => {}, /--reason/],
    ["with a blank --reason", ["inject", "f.json", "--reason= "], () => {}, /--reason/],
    ["when --reason is followed by another flag", ["inject", "f.json", "--reason", "--test"], () => {}, /--reason/],
  ])("inject refuses %s", async (_label, args, arrange, msg) => {
    arrange();
    await runCli(args);

    expect(cliError().message).toMatch(msg);
    expect(m.withSyncRun).not.toHaveBeenCalled();
    expect(m.injectFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("inject --test refuses when the target store is prod", async () => {
    m.loadDbConfig.mockReturnValue({ storeId: "prod.myshopify.com" });
    await runCli(["inject", "f.json", "--test", "--reason", "x"]);

    expect(cliError().message).toMatch(/prod\.myshopify\.com/);
    expect(m.injectFile).not.toHaveBeenCalled();
  });

  it("inject --test refuses when the mirror DB holds the prod store, whatever STORE_ID says", async () => {
    m.findStore.mockResolvedValue({ myshopifyDomain: "prod.myshopify.com" });
    await runCli(["inject", "f.json", "--test", "--reason", "x"]);

    expect(cliError().message).toMatch(/may not be loaded/);
    expect(m.injectFile).not.toHaveBeenCalled();
  });

  it("a HAND_LOADED inject into the prod mirror is allowed", async () => {
    m.findStore.mockResolvedValue({ myshopifyDomain: "prod.myshopify.com" });
    m.loadDbConfig.mockReturnValue({ storeId: "prod.myshopify.com" });
    m.injectFile.mockResolvedValue([]);
    await runCli(["inject", "f.json", "--reason", "historical CSV load"]);

    expect(m.injectFile).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("an unknown command fails with exitCode 1 and still disconnects", async () => {
    await runCli(["wibble"]);

    expect(process.exitCode).toBe(1);
    expect(m.disconnect).toHaveBeenCalledOnce();
  });

  it("always disconnects prisma, even on the happy path", async () => {
    m.request.mockResolvedValue({ shop: { name: "S", myshopifyDomain: "s", currencyCode: "USD", ianaTimezone: "UTC" } });

    await runCli(["ping"]);

    expect(m.disconnect).toHaveBeenCalledOnce();
  });
});
