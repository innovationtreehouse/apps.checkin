import { describe, expect, it } from "vitest";
import type { MailPart } from "../../contract";
import { isAutomated } from "../../services/mailReplies";

const msg = (headers: [string, string][], mimeType = "multipart/mixed"): MailPart => ({
  mimeType,
  headers: headers.map(([name, value]) => ({ name, value })),
});

describe("isAutomated", () => {
  it("passes a message a person wrote", () => {
    expect(isAutomated(msg([["From", "a@example.org"], ["Auto-Submitted", "no"], ["Return-Path", "<a@example.org>"]]), "a@example.org")).toBe(false);
  });

  it.each<[string, MailPart, string | null]>([
    ["an auto-reply", msg([["Auto-Submitted", "auto-replied"]]), "a@example.org"],
    ["an auto-generated message with parameters", msg([["auto-submitted", "Auto-Generated; owner-email=x@y"]]), "a@example.org"],
    ["bulk mail", msg([["Precedence", "Bulk"]]), "a@example.org"],
    ["list mail", msg([["Precedence", "list"]]), "a@example.org"],
    ["a vacation responder", msg([["X-Autoreply", "yes"]]), "a@example.org"],
    ["an autoresponder", msg([["X-Autorespond", "1"]]), "a@example.org"],
    ["a message asking not to be answered", msg([["X-Auto-Response-Suppress", "All"]]), "a@example.org"],
    ["a bounce with an empty envelope sender", msg([["Return-Path", "< >"]]), "a@example.org"],
    ["a delivery report", msg([], "multipart/report"), "a@example.org"],
    ["mail from a mailer daemon", msg([]), "mailer-daemon@example.org"],
    ["mail from a postmaster", msg([]), "postmaster@example.org"],
  ])("refuses %s", (_label, payload, address) => {
    expect(isAutomated(payload, address)).toBe(true);
  });
});
