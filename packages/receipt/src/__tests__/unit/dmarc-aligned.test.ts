import { describe, expect, it } from "vitest";
import { dmarcAligned } from "../../services/mailIntake";

const aligned = (...auth: string[]) =>
  dmarcAligned(
    auth.map((value) => ({ name: "Authentication-Results", value })),
    "alice@example.org",
  );

// The shape Gmail writes, folded across lines, with a base64 header.b and an ARC comment.
const GMAIL = [
  "mx.google.com;",
  "       dkim=pass header.i=@example.org header.s=s1 header.b=QYd1/Qh+;",
  "       arc=pass (i=1 spf=pass spfdomain=example.org dkim=pass dkdomain=example.org dmarc=pass fromdomain=example.org);",
  "       spf=pass (google.com: domain of alice@example.org designates 192.0.2.1 as permitted sender) smtp.mailfrom=alice@example.org;",
  "       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.org",
].join("\r\n");

describe("dmarcAligned", () => {
  it("accepts Google's real header shape", () => {
    expect(aligned(GMAIL)).toBe(true);
    expect(aligned("mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass (p=NONE sp=NONE) header.from=example.org")).toBe(true);
    expect(aligned("MX.Google.com 1; DMARC/1=PASS header.from=Example.ORG")).toBe(true);
  });

  it("rejects a failed, misaligned, or missing DMARC result", () => {
    expect(aligned(GMAIL.replace("dmarc=pass (p", "dmarc=fail (p"))).toBe(false);
    expect(aligned(GMAIL.replace("header.from=example.org", "header.from=example.net"))).toBe(false);
    expect(aligned("mx.google.com; spf=pass smtp.mailfrom=alice@example.org")).toBe(false);
    expect(aligned("mx.google.com; none")).toBe(false);
    expect(aligned()).toBe(false);
  });

  it("reads only the topmost header, and only Google's", () => {
    expect(aligned(GMAIL.replace("mx.google.com", "mx.example.net"), GMAIL)).toBe(false);
    expect(aligned(GMAIL.replace("dmarc=pass (p", "dmarc=none (p"), GMAIL)).toBe(false);
  });

  it("never reads a method result out of a quoted local part", () => {
    const quoted = 'smtp.mailfrom="x; dmarc=pass header.from=example.org"@example.net';
    expect(aligned(`mx.google.com; spf=pass ${quoted}`)).toBe(false);
    expect(aligned(`mx.google.com; spf=pass ${quoted}; dmarc=fail header.from=example.org`)).toBe(false);
  });

  it("ignores method results inside comments", () => {
    expect(aligned("mx.google.com; spf=pass (x; dmarc=pass header.from=example.org) smtp.mailfrom=a@example.net")).toBe(false);
    expect(aligned("mx.google.com; dmarc=fail (dmarc=pass header.from=example.org) header.from=example.org")).toBe(false);
    expect(aligned("mx.google.com; dmarc=pass header.from=example.net (header.from=example.org)")).toBe(false);
  });

  it("fails closed on two dmarc results, two header.from properties, or a broken header", () => {
    expect(aligned(`${GMAIL}; dmarc=pass header.from=example.org`)).toBe(false);
    expect(aligned("mx.google.com; dmarc=pass header.from=example.org header.from=example.org")).toBe(false);
    expect(aligned('mx.google.com; dmarc=pass header.from="example.org')).toBe(false);
    expect(aligned("mx.google.com; dmarc=pass (p=NONE header.from=example.org")).toBe(false);
    expect(aligned("mx.google.com extra; dmarc=pass header.from=example.org")).toBe(false);
  });
});
