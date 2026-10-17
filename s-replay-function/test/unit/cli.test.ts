/**
 * The dev CLI (`npm run replay|reset-watermark|reingest-bulk`). cli.ts runs main() on
 * import, so each case sets process.argv, imports the module fresh, and flushes the floating
 * main().catch().finally() chain before asserting. The handler is mocked (its dispatch is
 * covered in handler.test.ts); this isolates argv → event construction, the --reason audit
 * gate, actor defaulting, unknown-command handling, and the always-runs $disconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  handler: vi.fn(),
  disconnect: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@checkin/s-ingest-core", () => ({
  prisma: { $disconnect: m.disconnect },
  logger: m.logger,
}));
vi.mock("../../src/handler.js", () => ({ handler: m.handler }));

const origArgv = process.argv;
const origUser = process.env.USER;

beforeEach(() => {
  vi.clearAllMocks();
  m.handler.mockResolvedValue({ ok: true });
  m.disconnect.mockResolvedValue(undefined);
  process.env.USER = "tom";
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = origArgv;
  process.env.USER = origUser;
  process.exitCode = undefined;
});

/** Run cli.ts with the given args and let main()'s promise chain settle. */
async function runCli(args: string[]): Promise<void> {
  process.argv = ["node", "cli.ts", ...args];
  vi.resetModules();
  await import("../../src/cli.js");
  await new Promise((r) => setImmediate(r));
}

const event = () => m.handler.mock.calls[0][0];

describe("cli — command dispatch", () => {
  it("replay: builds the replay event with all flags and the default actor", async () => {
    await runCli(["replay", "--reason", "repair divergence", "--gid", "gid://x/Order/1", "--since", "2026-01-01T00:00:00Z", "--object", "ORDER", "--store", "s1"]);

    expect(event()).toEqual({
      mode: "replay",
      storeId: "s1",
      objectType: "ORDER",
      gid: "gid://x/Order/1",
      actor: "cli:tom",
      reason: "repair divergence",
      since: "2026-01-01T00:00:00Z",
    });
    expect(m.logger.info).toHaveBeenCalledWith("replay done", { ok: true });
    expect(m.disconnect).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("reset-watermark: a missing --to clears the watermark (to: null)", async () => {
    await runCli(["reset-watermark", "--reason", "rewind"]);

    expect(event()).toMatchObject({ mode: "reset-watermark", to: null, reason: "rewind" });
  });

  it("reingest-bulk: maps --bulk to bulkOperationId and --since through", async () => {
    await runCli(["reingest-bulk", "--reason", "rebuild", "--bulk", "gid://x/BulkOperation/9", "--since", "2026-02-02T00:00:00Z"]);

    expect(event()).toMatchObject({
      mode: "reingest-bulk",
      bulkOperationId: "gid://x/BulkOperation/9",
      since: "2026-02-02T00:00:00Z",
    });
  });

  it("--all sets scope: \"all\"; without it no scope key is sent", async () => {
    await runCli(["reset-watermark", "--reason", "rewind", "--all"]);
    expect(event()).toMatchObject({ mode: "reset-watermark", scope: "all" });

    m.handler.mockClear();
    await runCli(["reset-watermark", "--reason", "rewind"]);
    expect(event()).not.toHaveProperty("scope");
  });

  it("an explicit --actor overrides the cli:<user> default", async () => {
    await runCli(["replay", "--reason", "r", "--actor", "alice"]);

    expect(event()).toMatchObject({ actor: "alice" });
  });
});

describe("cli — guard rails", () => {
  it("rejects a missing --reason (audit gate): no handler call, exitCode 1, still disconnects", async () => {
    await runCli(["replay"]);

    expect(m.handler).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith("cli failed", expect.objectContaining({ err: expect.any(Error) }));
    expect(process.exitCode).toBe(1);
    expect(m.disconnect).toHaveBeenCalledOnce();
  });

  it("rejects an unknown command with exitCode 1", async () => {
    await runCli(["frobnicate", "--reason", "r"]);

    expect(m.handler).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(m.disconnect).toHaveBeenCalledOnce();
  });

  it("a handler rejection is caught: exitCode 1, logged, disconnect still runs", async () => {
    m.handler.mockRejectedValue(new Error("lock held"));

    await runCli(["replay", "--reason", "r"]);

    expect(process.exitCode).toBe(1);
    expect(m.logger.error).toHaveBeenCalled();
    expect(m.disconnect).toHaveBeenCalledOnce();
  });
});
