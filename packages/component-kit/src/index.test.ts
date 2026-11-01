import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ComponentHttpError,
  NotWiredError,
  ServiceError,
  callerId,
  defineRuntime,
  httpError,
  isComponentHttpError,
  isServiceError,
  mapServiceErrors,
  orgEventStep,
  parseBody,
  parseId,
  readJson,
  sweepOrgEvents,
  toHttpError,
  zodMessage,
} from "./index";

class LimitError extends ServiceError {
  constructor() {
    super(429, "limit");
    this.name = "LimitError";
  }
}

/** A copy of ServiceError from a second bundle: same brand, different class. */
function foreignServiceError(status: number, message: string): Error {
  const err = new Error(message);
  Object.assign(err, { [Symbol.for("@checkin/component-kit/ServiceError")]: true, status });
  return err;
}

const jsonRequest = (body: string) => new Request("http://x/", { method: "POST", body });

describe("error recognition", () => {
  it("recognises its own errors and a subclass that renames itself", () => {
    expect(isServiceError(new ServiceError(404, "x"))).toBe(true);
    expect(isServiceError(new LimitError())).toBe(true);
    expect(isComponentHttpError(httpError(400, "x"))).toBe(true);
    expect(isServiceError(httpError(400, "x"))).toBe(false);
  });

  it("recognises a copy from another bundle by brand, not instanceof", () => {
    const foreign = foreignServiceError(409, "taken");
    expect(foreign instanceof ServiceError).toBe(false);
    expect(isServiceError(foreign)).toBe(true);
    expect(toHttpError(foreign)).toMatchObject({ status: 409, message: "taken" });
  });

  it("does not recognise a plain error with a status", () => {
    expect(isServiceError(Object.assign(new Error("x"), { status: 400, name: "ServiceError" }))).toBe(false);
    expect(toHttpError(new Error("boom"))).toBeNull();
  });
});

describe("mapServiceErrors", () => {
  it("maps ServiceError, keeps ComponentHttpError, and rethrows anything else", async () => {
    await expect(mapServiceErrors(async () => { throw new LimitError(); })).rejects.toMatchObject({ status: 429, message: "limit" });
    const own = httpError(403, "no");
    await expect(mapServiceErrors(async () => { throw own; })).rejects.toBe(own);
    const other = new Error("boom");
    await expect(mapServiceErrors(async () => { throw other; })).rejects.toBe(other);
    await expect(mapServiceErrors(async () => 7)).resolves.toBe(7);
  });

  it("keeps a ServiceError's code, and sets none when it has none", async () => {
    const coded = await mapServiceErrors(async () => { throw new ServiceError(409, "taken", "already_open"); }).catch((e: unknown) => e);
    expect(coded).toMatchObject({ status: 409, message: "taken", code: "already_open" });
    expect(toHttpError(new ServiceError(409, "taken"))?.code).toBeUndefined();
    expect(toHttpError(httpError(403, "no", "forbidden"))?.code).toBe("forbidden");
  });

  it("maps a service-side ZodError to a 400 with the first issue's message", async () => {
    const schema = z.object({ amount: z.number({ error: "amount must be a number" }) });
    const err = await mapServiceErrors(async () => schema.parse({ amount: "x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComponentHttpError);
    expect(err).toMatchObject({ status: 400, message: "amount must be a number", fields: ["amount"] });
  });

  it("keeps a thrown ComponentHttpError's fields, and sets none on a ServiceError", () => {
    expect(toHttpError(httpError(400, "bad", undefined, ["email"]))?.fields).toEqual(["email"]);
    expect(toHttpError(new ServiceError(409, "taken"))?.fields).toBeUndefined();
  });
});

describe("parseId", () => {
  it("accepts a positive integer", () => {
    expect(parseId("12")).toBe(12);
  });

  it.each([
    "12abc", "abc", "", "0", "-3", "1.5", undefined, null,
    "0x1f", "0b11", "0o7", "1e2", " 42", "42 ", "012", "+5", "Infinity", "9007199254740993",
  ])("rejects %p with a 400", (raw) => {
    expect(() => parseId(raw, "item id")).toThrow(expect.objectContaining({ status: 400, message: "Invalid item id" }));
  });
});

describe("parseBody", () => {
  const schema = z.object({ name: z.string({ error: "name is required" }) });

  it("returns the parsed body", async () => {
    await expect(parseBody(jsonRequest('{"name":"a"}'), schema)).resolves.toEqual({ name: "a" });
  });

  it("is a 400 with the first issue's message on a schema failure", async () => {
    await expect(parseBody(jsonRequest("{}"), schema)).rejects.toMatchObject({ status: 400, message: "name is required" });
  });

  it("names each refused top-level input once, and never a submitted value", async () => {
    const nested = z.object({
      name: z.string().min(3),
      lines: z.array(z.object({ note: z.string() })),
      extras: z.object({}).catchall(z.number()),
    });
    const secret = "secret-value";
    const body = JSON.stringify({ name: "x", lines: [{ note: 1 }, { note: 2 }], extras: { [secret]: secret } });
    const err = await parseBody(jsonRequest(body), nested).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, fields: ["name", "lines", "extras"] });
    expect(JSON.stringify((err as ComponentHttpError).fields)).not.toContain(secret);
  });

  it("names nothing for an issue with an empty path or a numeric first segment", async () => {
    const strict = await parseBody(jsonRequest('{"typo":1}'), z.object({}).strict()).catch((e: unknown) => e);
    expect(strict).toMatchObject({ status: 400, fields: [] });
    const list = await parseBody(jsonRequest('["a"]'), z.array(z.number())).catch((e: unknown) => e);
    expect(list).toMatchObject({ status: 400, fields: [] });
  });

  it("is a 400 on a body that is not JSON", async () => {
    await expect(readJson(jsonRequest("{"))).rejects.toMatchObject({ status: 400, message: "Invalid JSON body" });
  });
});

describe("zodMessage", () => {
  it("falls back when there are no issues", () => {
    expect(zodMessage({ issues: [] })).toBe("Invalid request body");
  });
});

describe("callerId", () => {
  it("returns an integer id", () => {
    expect(callerId({ id: 7 })).toBe(7);
  });

  it.each([null, undefined, {}, { id: "7" }, { id: 1.5 }, { id: Number.NaN }])("is a 401 for %p", (principal) => {
    expect(() => callerId(principal)).toThrow(expect.objectContaining({ status: 401, message: "Unauthorized" }));
  });
});

describe("defineRuntime", () => {
  interface Principal {
    id: number;
    name: string | null;
  }
  interface Config {
    org?: () => Promise<{ id: string }>;
    auth?: { getPrincipal(): Promise<Principal | null> };
    port?: string;
  }
  const runtime = defineRuntime<Config, Principal>("kit-test");
  const configured = (over: Partial<Config> = {}) =>
    runtime.configure({ org: async () => ({ id: "org-1" }), auth: { getPrincipal: async () => ({ id: 3, name: "A" }) }, ...over });

  it("throws from every accessor until configured", async () => {
    runtime.reset();
    expect(() => runtime.require()).toThrow("kit-test runtime not configured");
    await expect(runtime.getPrincipal()).rejects.toThrow("kit-test runtime not configured");
    await expect(runtime.getOrgId()).rejects.toThrow("kit-test runtime not configured");
    await expect(runtime.assertOrg("org-1")).rejects.toThrow("kit-test runtime not configured");
  });

  it("configured() reads without throwing", () => {
    runtime.reset();
    expect(runtime.configured()).toBeUndefined();
    configured({ port: "bound" });
    expect(runtime.configured()?.port).toBe("bound");
  });

  it("shares one configuration across copies of the module", () => {
    configured({ port: "bound" });
    expect(defineRuntime<Config, Principal>("kit-test").require().port).toBe("bound");
  });

  it("reads the principal and the org", async () => {
    configured();
    await expect(runtime.getPrincipal()).resolves.toEqual({ id: 3, name: "A" });
    await expect(runtime.getOrgId()).resolves.toBe("org-1");
  });

  it("is a 401 for a missing principal or one without an integer id", async () => {
    configured({ auth: { getPrincipal: async () => null } });
    await expect(runtime.getPrincipal()).rejects.toMatchObject({ status: 401 });
    configured({ auth: { getPrincipal: async () => ({ id: 1.5, name: null }) } });
    await expect(runtime.getPrincipal()).rejects.toMatchObject({ status: 401 });
  });

  it("throws NotWiredError for unbound auth or org", async () => {
    runtime.configure({});
    await expect(runtime.getPrincipal()).rejects.toBeInstanceOf(NotWiredError);
    await expect(runtime.getOrgId()).rejects.toBeInstanceOf(NotWiredError);
  });

  it("assertOrg passes the injected org and refuses any other", async () => {
    configured();
    await expect(runtime.assertOrg("org-1")).resolves.toBeUndefined();
    await expect(runtime.assertOrg("org-2")).rejects.toThrow("orgId org-2 is not this org");
  });
});

describe("orgEventStep", () => {
  const base = { onFailure: () => undefined, recordFailure: async () => true };

  it("returns the check's outcome without applying", async () => {
    let applied = false;
    const step = orgEventStep<number, "duplicate">({ ...base, check: async () => "duplicate", apply: async () => { applied = true; } });
    expect(await step(1)).toBe("duplicate");
    expect(applied).toBe(false);
  });

  it("records a failed apply, and defers to an overlapping processed outcome", async () => {
    const boom = async () => { throw new Error("boom"); };
    const reasons: string[] = [];
    const stands = orgEventStep<number>({ ...base, apply: boom, recordFailure: async (_e, reason) => { reasons.push(reason); return true; } });
    expect(await stands(1)).toBe("failed");
    expect(reasons).toEqual(["boom"]);
    expect(await orgEventStep<number>({ ...base, apply: boom, recordFailure: async () => false })(1)).toBe("duplicate");
  });

  it("throws a recordProcessed failure instead of recording it", async () => {
    let recorded = false;
    const step = orgEventStep<number>({
      ...base,
      apply: async () => undefined,
      recordProcessed: async () => { throw new Error("ledger down"); },
      recordFailure: async () => { recorded = true; return true; },
    });
    await expect(step(1)).rejects.toThrow("ledger down");
    expect(recorded).toBe(false);
  });
});

describe("sweepOrgEvents", () => {
  function run(opts: { all: number[]; failed?: number[]; received?: number[]; limit?: number; bad?: number[]; pageSize?: number }) {
    const order: number[] = [];
    const result = sweepOrgEvents<number>({
      limit: opts.limit ?? 100,
      failed: opts.failed ?? [],
      readPage: async (after) => opts.all.filter((id) => id > after).slice(0, opts.pageSize ?? 2),
      idOf: (id) => id,
      receivedIds: async (ids) => ids.filter((id) => opts.received?.includes(id)),
      consume: async (id) => {
        order.push(id);
        return opts.bad?.includes(id) ? "failed" : "processed";
      },
      onUnrecorded: () => undefined,
      onUnreadable: () => undefined,
    });
    return { result, order };
  }

  it("reads past received ids across pages, however many followed", async () => {
    const { result, order } = run({ all: [1, 2, 3, 4, 5], received: [1, 2, 4] });
    expect((await result).needsAlert).toBe(false);
    expect(order).toEqual([3, 5]);
  });

  it("retries a tenth of the cap first, new events next, then more retries with what is left", async () => {
    const { result, order } = run({ all: [50, 51], failed: [1, 2, 3], received: [1, 2, 3], limit: 10 });
    const res = await result;
    expect(order).toEqual([1, 50, 51, 2, 3]);
    expect(res.unprocessed).toBe(0);
  });

  it("counts what the cap left, and alerts only if the run processed nothing", async () => {
    const progressed = await run({ all: [1, 2, 3], limit: 1 }).result;
    expect(progressed).toMatchObject({ unprocessed: 2, needsAlert: false });
    const stalled = await run({ all: [1, 2], limit: 1, bad: [1] }).result;
    expect(stalled).toMatchObject({ newlyFailed: 1, unprocessed: 1, needsAlert: true });
  });

  it("a retry failing again is counted but is not newly failed", async () => {
    const res = await run({ all: [1], failed: [1], received: [1], bad: [1] }).result;
    expect(res).toMatchObject({ newlyFailed: 0, needsAlert: false });
    expect(res.counts.failed).toBe(1);
  });

  it("survives an unrecorded event and an unreadable catalog", async () => {
    const unrecorded: number[] = [];
    let unreadable = 0;
    const res = await sweepOrgEvents<number>({
      limit: 10,
      failed: [9],
      readPage: async () => { throw new Error("down"); },
      idOf: (id) => id,
      receivedIds: async () => [],
      consume: async () => { throw new Error("ledger down"); },
      onUnrecorded: (id) => unrecorded.push(id),
      onUnreadable: () => { unreadable++; },
    });
    expect(unrecorded).toEqual([9]);
    expect(unreadable).toBe(1);
    expect(res).toMatchObject({ unreadable: true, needsAlert: true });
    expect(res.counts.failed).toBe(1);
  });
});
