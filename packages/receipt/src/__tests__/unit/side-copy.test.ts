import { describe, expect, it } from "vitest";
import { isSideCopy } from "../../services/mailIntake";

const MAILBOX = "receipts@example.org";
const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

describe("isSideCopy", () => {
  it.each([
    ["the mailbox is only in Cc", { To: "bob@example.org", Cc: "Receipts <Receipts@Example.org>, carol@example.org" }],
    ["the message replies to another", { To: MAILBOX, "In-Reply-To": "<abc@example.org>" }],
  ])("is true when %s", (_, h) => {
    expect(isSideCopy(headers(h), MAILBOX)).toBe(true);
  });

  it.each([
    ["the mailbox is in To", { To: `"Receipts, Treehouse" <${MAILBOX}>` }],
    ["the mailbox is in both To and Cc", { To: MAILBOX, Cc: MAILBOX }],
    ["the message went to an alias of the mailbox", { To: "expenses@example.org" }],
    ["the alias is in To and another person in Cc", { To: "expenses@example.org", Cc: "bob@example.org" }],
    ["the mailbox is only in Bcc", { To: "bob@example.org" }],
  ])("is false when %s", (_, h) => {
    expect(isSideCopy(headers(h), MAILBOX)).toBe(false);
  });
});
