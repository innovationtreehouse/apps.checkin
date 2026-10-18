import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ComponentHttpError,
  ServiceError,
  httpError,
  isComponentHttpError,
  isServiceError,
  mapServiceErrors,
  parseBody,
  parseId,
  readJson,
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

  it("maps a service-side ZodError to a 400 with the first issue's message", async () => {
    const schema = z.object({ amount: z.number({ error: "amount must be a number" }) });
    const err = await mapServiceErrors(async () => schema.parse({ amount: "x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComponentHttpError);
    expect(err).toMatchObject({ status: 400, message: "amount must be a number" });
  });
});

describe("parseId", () => {
  it("accepts a positive integer", () => {
    expect(parseId("12")).toBe(12);
  });

  it.each(["12abc", "abc", "", "0", "-3", "1.5", undefined, null])("rejects %p with a 400", (raw) => {
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

  it("is a 400 on a body that is not JSON", async () => {
    await expect(readJson(jsonRequest("{"))).rejects.toMatchObject({ status: 400, message: "Invalid JSON body" });
  });
});

describe("zodMessage", () => {
  it("falls back when there are no issues", () => {
    expect(zodMessage({ issues: [] })).toBe("Invalid request body");
  });
});
