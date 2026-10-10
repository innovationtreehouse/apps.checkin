import { beforeEach, describe, expect, it } from "vitest";
import { callerId, requireActor } from "../../runtime";
import { configure } from "../helpers/setup";

describe("actor ids come only from an integer principal id", () => {
  beforeEach(() => configure());

  it("callerId returns an integer id", () => {
    expect(callerId({ id: 12 })).toBe(12);
  });

  it.each([undefined, null, "12", 1.5, Number.NaN])("callerId throws on %s", (id) => {
    expect(() => callerId({ id })).toThrow();
  });

  it("requireActor is 401 with no principal", async () => {
    configure({ principal: null });
    await expect(requireActor()).rejects.toMatchObject({ status: 401 });
  });

  it.each([Number.NaN, 1.5])("requireActor is 401 for a principal whose id is %s", async (id) => {
    configure({ principal: { id, name: "ghost" } });
    await expect(requireActor()).rejects.toMatchObject({ status: 401 });
  });
});
