import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/redact.js";

describe("redactSecrets", () => {
  it("strips URLs with a query string, keeping plain ones", () => {
    expect(redactSecrets("GET https://shop.example.com/admin/api/orders.json?access_token=abc123 failed")).toBe("GET [url] failed");
    expect(redactSecrets("POST https://shop.example.com/admin/api/graphql.json returned 502")).toBe(
      "POST https://shop.example.com/admin/api/graphql.json returned 502",
    );
  });

  it("strips email addresses", () => {
    expect(redactSecrets("customer jane.doe+x@example.org not found")).toBe("customer [email] not found");
  });

  it("strips auth headers, key=value secrets and token prefixes", () => {
    expect(redactSecrets("X-Shopify-Access-Token: shpat_0123456789abcdef")).toBe("X-Shopify-Access-Token: [redacted]");
    expect(redactSecrets('{"client_secret":"s3cr3t","ok":true}')).toBe('{"client_secret":"[redacted]","ok":true}');
    expect(redactSecrets("used key shpat_0123456789abcdef0123")).toBe("used key [redacted]");
    expect(redactSecrets("Bearer eyJhbGciOi.payload.sig")).toBe("Bearer [redacted]");
    expect(redactSecrets("connect postgres://app:password=hunter2@db")).not.toContain("hunter2");
  });

  it("strips long opaque strings", () => {
    expect(redactSecrets("sig 0123456789abcdef0123456789abcdef01 bad")).toBe("sig [redacted] bad");
  });

  it("leaves ordinary error text alone", () => {
    const msg = 'bulk operation failed: {"errors":["Throttled"]} at line_item_id_missing';
    expect(redactSecrets(msg)).toBe(msg);
  });
});
