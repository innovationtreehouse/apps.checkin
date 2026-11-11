import { afterEach, describe, expect, it, vi } from "vitest";
import { handler } from "./handler";

afterEach(() => vi.unstubAllEnvs());

describe("handler", () => {
  it.each([
    ["GMAIL_CLIENT_SECRET_ID", "GMAIL_TOKEN_SECRET_ID"],
    ["GMAIL_TOKEN_SECRET_ID", "GMAIL_CLIENT_SECRET_ID"],
  ])("throws when %s is not set", async (missing, present) => {
    vi.stubEnv(missing, "");
    vi.stubEnv(present, "secret-id");
    await expect(handler({ action: "current" })).rejects.toThrow(/must be set/);
  });
});
