import { CatalogHttpError } from "@inventory/global-catalog";
import { ApiResponseError } from "@/security/handler";
import { catalogRoute } from "../route";

// The library's root entry pulls in its generated Prisma client, which the
// jest env does not build; only the error class is needed here.
jest.mock("@inventory/global-catalog", () => ({
  CatalogHttpError: class CatalogHttpError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

const ctx = { req: new Request("http://localhost/api/catalog/items/1"), params: {} };

describe("catalogRoute", () => {
  it("rethrows a library CatalogHttpError as checkin's ApiResponseError with the same status", async () => {
    const route = catalogRoute(async () => {
      throw new CatalogHttpError(404, "Item not found");
    });
    const err = await route(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).toMatchObject({ status: 404, message: "Item not found" });
  });

  it("passes other errors through untouched", async () => {
    const boom = new Error("db down");
    const route = catalogRoute(async () => {
      throw boom;
    });
    await expect(route(ctx)).rejects.toBe(boom);
  });

  it("returns the factory's bag on success", async () => {
    const route = catalogRoute(async () => ({ Item: { gtin13: "1" } }));
    await expect(route(ctx)).resolves.toEqual({ Item: { gtin13: "1" } });
  });
});
