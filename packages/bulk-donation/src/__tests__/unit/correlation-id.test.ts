/** The audit correlation id keeps a short caller token and replaces anything else with a UUID. */
import { describe, it, expect } from "vitest";
import { correlationId } from "../../routes/_shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function withHeader(value?: string): Request {
  return new Request("http://x/", value === undefined ? {} : { headers: { "x-correlation-id": value } });
}

describe("correlationId", () => {
  it("keeps a short safe token", () => {
    expect(correlationId(withHeader("req-42.a:b_c"))).toBe("req-42.a:b_c");
    const uuid = crypto.randomUUID();
    expect(correlationId(withHeader(uuid))).toBe(uuid);
  });

  it("replaces a missing, oversized or unsafe value with a fresh UUID", () => {
    for (const value of [undefined, "", "a".repeat(65), "has space", "<script>", "lineé"]) {
      expect(correlationId(withHeader(value))).toMatch(UUID);
    }
  });
});
