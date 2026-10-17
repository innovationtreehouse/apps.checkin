/**
 * The local `run:once` entry point. cli.ts has a top-level side effect (it invokes the
 * handler on import), so each case sets up the handler mock, then dynamically imports the
 * module under a fresh registry and flushes the floating then/catch chain before asserting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("./handler.js", () => ({ handler: h.handler }));

// requeue-dead path collaborators: the DB helper + config are stubbed so the CLI dispatch is
// exercised without a real database. Unused (and harmless) on the run:once path.
const db = vi.hoisted(() => ({ requeueDead: vi.fn(), prisma: { __brand: "prisma" } }));
vi.mock("@checkin/monitoring-db", () => ({ prisma: db.prisma, requeueDead: db.requeueDead }));
const c = vi.hoisted(() => ({ loadRelayConfig: vi.fn() }));
vi.mock("./config.js", () => ({ loadRelayConfig: c.loadRelayConfig }));

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const savedArgv = process.argv;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  c.loadRelayConfig.mockReturnValue({ snsTopicArn: "arn:x", env: "test", monitorName: "monitoring-relay", batchLimit: 50, maxAttempts: 5 });
  db.requeueDead.mockResolvedValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = savedArgv;
});

/** Import cli.ts fresh (so its top-level run fires) and let the floating promise chain settle. */
async function runCli(argv: string[] = []): Promise<void> {
  process.argv = ["node", "cli.js", ...argv];
  vi.resetModules();
  await import("./cli.js");
  await new Promise((r) => setImmediate(r));
}

describe("cli (run:once)", () => {
  it("on success logs the relay result with ok:true and exits 0", async () => {
    h.handler.mockResolvedValue({ delivered: 3, failed: 0 });

    await runCli();

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, delivered: 3, failed: 0 }));
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("on failure logs the error to stderr and exits 1", async () => {
    const boom = new Error("monitoring DB unreachable");
    h.handler.mockRejectedValue(boom);

    await runCli();

    expect(errSpy).toHaveBeenCalledWith(boom);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("cli (requeue-dead)", () => {
  it("with no id requeues ALL dead rows for the env, logs the count, exits 0", async () => {
    db.requeueDead.mockResolvedValue(2);

    await runCli(["requeue-dead"]);

    expect(db.requeueDead).toHaveBeenCalledWith(db.prisma, "test", {});
    expect(h.handler).not.toHaveBeenCalled(); // not the drain path
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, requeued: 2, env: "test", id: "all" }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("with a numeric id requeues that single row (parsed to BigInt)", async () => {
    db.requeueDead.mockResolvedValue(1);

    await runCli(["requeue-dead", "123"]);

    expect(db.requeueDead).toHaveBeenCalledWith(db.prisma, "test", { id: 123n });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, requeued: 1, env: "test", id: "123" }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("a non-numeric id fails fast (BigInt throws) → stderr + exit 1", async () => {
    await runCli(["requeue-dead", "not-a-number"]);

    expect(db.requeueDead).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
