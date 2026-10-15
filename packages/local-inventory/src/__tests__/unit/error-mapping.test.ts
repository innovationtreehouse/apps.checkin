/**
 * The library's error mapper renders every expected domain failure with its own status and
 * leaves anything else to become the host's opaque 500 (docs/conventions.md, library errors).
 */
import { describe, it, expect } from "vitest";
import { mapServiceErrors, InventoryHttpError } from "../../runtime";
import { ServiceError } from "../../lib/services/serviceError";

describe("mapServiceErrors", () => {
  it.each([
    [400, "validation"],
    [403, "forbidden"],
    [404, "not found"],
    [409, "conflict or duplicate"],
  ])("renders a ServiceError(%i) as a InventoryHttpError with that status (%s)", async (status, message) => {
    const err = await mapServiceErrors(() => Promise.reject(new ServiceError(status, message))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryHttpError);
    expect(err).toMatchObject({ status, message });
  });

  it("rethrows any other error untouched, so the host answers 500", async () => {
    const boom = new Error("boom");
    await expect(mapServiceErrors(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});
