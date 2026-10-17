/**
 * The library's error mapper renders every expected domain failure with its own status and
 * leaves anything else to become the host's opaque 500 (docs/conventions.md, library errors).
 */
import { describe, it, expect } from "vitest";
import { mapServiceErrors, ExpenseHttpError } from "../../routes/_shared";
import { ServiceError } from "../../services/serviceError";
import { z } from "zod";

describe("mapServiceErrors", () => {
  it.each([
    [400, "validation"],
    [403, "forbidden"],
    [404, "not found"],
    [409, "conflict or duplicate"],
  ])("renders a ServiceError(%i) as a ExpenseHttpError with that status (%s)", async (status, message) => {
    const err = await mapServiceErrors(() => Promise.reject(new ServiceError(status, message))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExpenseHttpError);
    expect(err).toMatchObject({ status, message });
  });

  it("renders a service-side zod parse failure as a 400", async () => {
    const err = await mapServiceErrors(async () => z.object({ n: z.number() }).parse({ n: "x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExpenseHttpError);
    expect(err).toMatchObject({ status: 400 });
  });

  it("rethrows any other error untouched, so the host answers 500", async () => {
    const boom = new Error("boom");
    await expect(mapServiceErrors(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});
