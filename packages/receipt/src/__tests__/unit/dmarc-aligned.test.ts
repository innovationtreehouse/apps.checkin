import { describe, expect, it } from "vitest";
import { dmarcAligned, dmarcVerdict } from "../../services/mailIntake";

const header = (name: string) => (value: string) => ({ name, value });

const aligned = (...auth: string[]) => dmarcAligned(auth.map(header("Authentication-Results")), "alice@example.org");

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
    expect(aligned("MX.Google.com 1; DKIM/1=PASS header.d=Example.ORG; DMARC/1=PASS header.from=Example.ORG")).toBe(true);
  });

  it("rejects a failed, misaligned, or missing DMARC result", () => {
    expect(aligned(GMAIL.replace("dmarc=pass (p", "dmarc=fail (p"))).toBe(false);
    expect(aligned(GMAIL.replace("header.from=example.org", "header.from=example.net"))).toBe(false);
    expect(aligned("mx.google.com; spf=pass smtp.mailfrom=alice@example.org")).toBe(false);
    expect(aligned("mx.google.com; none")).toBe(false);
    expect(aligned()).toBe(false);
  });

  it("requires a passing DKIM signature by the From domain itself", () => {
    const dmarcPass = "dmarc=pass (p=NONE) header.from=example.org";
    expect(aligned(`mx.google.com; spf=pass smtp.mailfrom=alice@example.org; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=fail header.i=@example.org; spf=pass; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.i=@mailer.example.net; spf=pass; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.i=@sub.example.org; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.i=@example.org.evil.net; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass (header.i=@example.org) header.s=s1; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.i=@mailer.example.net; dkim=pass header.i=alice@example.org; ${dmarcPass}`)).toBe(true);
    expect(aligned(`mx.google.com; dkim=pass header.d=example.org header.s=s1; ${dmarcPass}`)).toBe(true);
  });

  it("fails a DKIM result whose signer properties disagree or are malformed", () => {
    const dmarcPass = "dmarc=pass header.from=example.org";
    expect(aligned(`mx.google.com; dkim=pass header.d=example.org header.i=@sub.example.org; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.i=@evil.net header.i=@example.org; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.i=example.org; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.s=s1; ${dmarcPass}`)).toBe(false);
    expect(aligned(`mx.google.com; dkim=pass header.d=example.org header.i=alice@example.org; ${dmarcPass}`)).toBe(true);
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

  describe("envelope sender", () => {
    const withReturnPath = (returnPath: string, auth: string, address = "alice@example.org") =>
      dmarcAligned([header("Return-Path")(returnPath), header("Authentication-Results")(auth)], address);

    // Gmail echoes MAIL FROM into the spf= comment and smtp.mailfrom; a quoted local part can close that comment.
    const breakout = '"x);dmarc=pass header.from=victim.org policy.x=y ("@attacker.net';
    const gmailFor = (mailFrom: string) =>
      `mx.google.com; spf=softfail (google.com: domain of transitioning ${mailFrom} does not designate 192.0.2.9 as permitted sender) smtp.mailfrom=${mailFrom}`;

    it("rejects a quoted local part that ends Gmail's comment early", () => {
      expect(withReturnPath(`<${breakout}>`, gmailFor(breakout), "bob@victim.org")).toBe(false);
      expect(dmarcAligned([header("Authentication-Results")(gmailFor(breakout))], "bob@victim.org")).toBe(false);
      const withSemicolon = '"x);dmarc=pass header.from=victim.org policy.x=y; ("@attacker.net';
      expect(dmarcAligned([header("Authentication-Results")(gmailFor(withSemicolon))], "bob@victim.org")).toBe(false);
    });

    it("rejects a Return-Path or smtp.mailfrom holding a quote, parenthesis, semicolon, or backslash", () => {
      for (const c of ['"', "(", ")", ";", "\\"]) {
        expect(withReturnPath(`<a${c}b@example.org>`, GMAIL)).toBe(false);
      }
      expect(aligned(GMAIL.replace("smtp.mailfrom=alice@example.org", 'smtp.mailfrom="a b"@example.org'))).toBe(false);
    });

    it("fails the parse on a quote inside a comment, whatever else the header holds", () => {
      expect(aligned('mx.google.com; spf=pass (domain of "x"@example.org); dmarc=pass header.from=example.org')).toBe(false);
    });

    it("accepts an ordinary envelope sender, including forwarding and bounce addresses", () => {
      expect(withReturnPath("<alice@example.org>", GMAIL)).toBe(true);
      expect(withReturnPath("<SRS0=Ab12=ZZ=example.org=alice@forwarder.example.net>", GMAIL)).toBe(true);
      expect(withReturnPath("<prvs=1234abcd=alice@example.org>", GMAIL)).toBe(true);
      expect(withReturnPath("<>", GMAIL)).toBe(true);
    });
  });
});

describe("dmarcVerdict", () => {
  const verdict = (auth: string, address: string | null = "alice@example.org") => dmarcVerdict([header("Authentication-Results")(auth)], address);

  it("passes only what dmarcAligned passes", () => {
    expect(verdict(GMAIL)).toBe("pass");
    expect(verdict("mx.google.com; spf=pass smtp.mailfrom=alice@example.org; dmarc=pass header.from=example.org")).toBe("fail");
  });

  it("is none only when Google reports no record for the From domain", () => {
    expect(verdict("mx.google.com; spf=pass; dmarc=none header.from=example.org")).toBe("none");
    expect(verdict("mx.google.com; dmarc=none header.from=example.net")).toBe("fail");
    expect(verdict("evil.example; dmarc=none header.from=example.org")).toBe("fail");
  });

  it("fails everything else", () => {
    expect(verdict(GMAIL.replace("dmarc=pass (p", "dmarc=fail (p"))).toBe("fail");
    expect(verdict(GMAIL, null)).toBe("fail");
    expect(dmarcVerdict(undefined, "alice@example.org")).toBe("fail");
  });
});
