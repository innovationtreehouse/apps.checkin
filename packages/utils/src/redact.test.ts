import { describe, it, expect } from "vitest";
import { REDACT_MAX_CHARS, redactSecrets } from "./index";

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
    expect(redactSecrets("Authorization: Zoho-oauthtoken 1000.abcdef.123456")).toBe("Authorization: [redacted] [redacted]");
    expect(redactSecrets("X-Shopify-Access-Token: shpat_0123456789abcdef")).toBe("X-Shopify-Access-Token: [redacted]");
    expect(redactSecrets('{"client_secret":"s3cr3t","ok":true}')).toBe('{"client_secret":"[redacted]","ok":true}');
    expect(redactSecrets("used key shpat_0123456789abcdef0123")).toBe("used key [redacted]");
    expect(redactSecrets("Bearer eyJhbGciOi.payload.sig")).toBe("Bearer [redacted]");
    expect(redactSecrets("connect postgres://app:password=hunter2@db")).not.toContain("hunter2");
  });

  it("strips env-style secret assignments, secret-named JSON fields and connection-string passwords", () => {
    expect(redactSecrets("missing CRON_SECRET=abc123def in env")).toBe("missing CRON_SECRET=[redacted] in env");
    expect(redactSecrets("SHOPIFY_API_KEY=k1 DB_PASSWORD=p2")).toBe("SHOPIFY_API_KEY=[redacted] DB_PASSWORD=[redacted]");
    expect(redactSecrets('{"shopifyWebhookSecret":"whsec_a\\"b","ok":true}')).toBe('{"shopifyWebhookSecret":"[redacted]","ok":true}');
    expect(redactSecrets("connect postgresql://app:hunter2pass@db.internal:5432/app")).toBe(
      "connect postgresql://app:[redacted]@db.internal:5432/app",
    );
  });

  it("stays linear on long separator-free input, uncapped", () => {
    const inputs = ["a", "a1", "a.", "a+", "x@", '"a'].map((unit) => unit.repeat(100_000 / unit.length));
    inputs.push('"' + "secret".repeat(100_000 / 6));
    for (const input of inputs) {
      const start = performance.now();
      redactSecrets(input, Infinity);
      expect(performance.now() - start).toBeLessThan(100);
    }
  });

  it("truncates input past the cap with a marker", () => {
    const out = redactSecrets("x".repeat(REDACT_MAX_CHARS + 10));
    expect(out).toBe(`${"x".repeat(REDACT_MAX_CHARS)}…[truncated 10 chars]`);
  });

  it("strips long opaque strings", () => {
    expect(redactSecrets("sig 0123456789abcdef0123456789abcdef01 bad")).toBe("sig [redacted] bad");
  });

  it("leaves ordinary error text alone", () => {
    const msg = 'bulk operation failed: {"errors":["Throttled"]} at line_item_id_missing';
    expect(redactSecrets(msg)).toBe(msg);
  });
});
