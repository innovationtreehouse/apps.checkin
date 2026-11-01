/**
 * @jest-environment node
 */
import { ServiceError, httpError } from "@checkin/component-kit";
import { z } from "zod";
import { ApiResponseError, renderApiResponseError } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { ReviewError } from "@/lib/membership/review";

const ctx = { req: new Request("http://localhost/api/catalog/items/1"), params: {} };

const failing = (err: unknown) =>
  componentRoute(async () => {
    throw err;
  });

/** A ServiceError from another loaded copy of the kit: same brand, different class. */
function foreignServiceError(status: number, message: string): Error {
  return Object.assign(new Error(message), { [Symbol.for("@checkin/component-kit/ServiceError")]: true, status });
}

/** A subclass that renames itself, as receipt's org-wide upload limit does. */
class UploadLimitError extends ServiceError {
  constructor() {
    super(429, "Receipt uploads have reached today's limit. Try again tomorrow.");
    this.name = "OrgUploadLimitError";
  }
}

describe("componentRoute", () => {
  it.each([
    ["a ComponentHttpError", httpError(404, "Item not found"), 404, "Item not found"],
    ["a ServiceError", new ServiceError(409, "taken"), 409, "taken"],
    ["a ServiceError from another bundle", foreignServiceError(403, "forbidden"), 403, "forbidden"],
    ["a renamed ServiceError subclass", new UploadLimitError(), 429, "Receipt uploads have reached today's limit. Try again tomorrow."],
  ])("renders %s as checkin's ApiResponseError with its status", async (_, thrown, status, message) => {
    const err = await failing(thrown)(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).toMatchObject({ status, message });
  });

  async function renderedBody(thrown: unknown) {
    const err = await failing(thrown)(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    const res = renderApiResponseError(err as ApiResponseError);
    return { status: res.status, body: await res.json() };
  }

  it("renders a ServiceError's code in the body", async () => {
    await expect(renderedBody(new ServiceError(409, "taken", "already_open"))).resolves.toEqual({
      status: 409,
      body: { error: "taken", code: "already_open" },
    });
  });

  it("renders a ServiceError with no code as a bare error body", async () => {
    await expect(renderedBody(new ServiceError(409, "taken"))).resolves.toEqual({ status: 409, body: { error: "taken" } });
  });

  it("renders a membership error with its code and mapped status", async () => {
    await expect(renderedBody(new ReviewError("not_reviewer", "You are not a background-check reviewer."))).resolves.toEqual({
      status: 403,
      body: { error: "You are not a background-check reviewer.", code: "not_reviewer" },
    });
  });

  it("renders a service-side ZodError as a 400, not an opaque 500", async () => {
    const schema = z.object({ amount: z.number({ error: "amount must be a number" }) });
    const route = componentRoute(async () => schema.parse({ amount: "x" }));
    const err = await route(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).toMatchObject({ status: 400, message: "amount must be a number" });
  });

  it("passes other errors through untouched, for the host's opaque 500", async () => {
    const boom = new Error("db down");
    await expect(failing(boom)(ctx)).rejects.toBe(boom);
    const lookalike = Object.assign(new Error("odd"), { name: "ServiceError", status: 409 });
    await expect(failing(lookalike)(ctx)).rejects.toBe(lookalike);
  });

  it("returns the factory's bag on success", async () => {
    const route = componentRoute(async () => ({ Item: { gtin13: "1" } }));
    await expect(route(ctx)).resolves.toEqual({ Item: { gtin13: "1" } });
  });
});
