import { describe, expect, it } from "vitest";
import { fromAddress } from "../../services/mailIntake";

const from = (value: string) => fromAddress([{ name: "From", value }]);

describe("fromAddress", () => {
  it.each([
    ["alice@example.org", "alice@example.org"],
    ["  Alice@Example.ORG\r\n", "alice@example.org"],
    ["<alice@example.org>", "alice@example.org"],
    ["Alice Smith <alice@example.org>", "alice@example.org"],
    ["Alice\r\n <alice@example.org>", "alice@example.org"],
    ["=?UTF-8?Q?Al=C3=ADce?= <alice@example.org>", "alice@example.org"],
    ["alice+receipts@mail.example.org", "alice+receipts@mail.example.org"],
    ["Jos\u00e9 <jose@example.org>", "jose@example.org"],
    ["jose@xn--bcher-kva.example", "jose@xn--bcher-kva.example"],
  ])("reads the ordinary address in %j", (value, address) => {
    expect(from(value)).toBe(address);
  });

  it.each([
    ['"Smith, Alice" <alice@example.org>'],
    ['"bob@example.org" <alice@example.org>'],
    ['"Alice (<bob@example.org>)" <alice@example.org>'],
    ['"Alice \\"A\\" Smith" <alice@example.org>'],
    ['"a\\\\" <alice@example.org>'],
  ])("reads the address after the quoted display name %j", (value) => {
    expect(from(value)).toBe("alice@example.org");
  });

  it.each([
    ["alice@example.org (Alice)"],
    ["(Alice) alice@example.org"],
    ["Alice <alice@example.org> (work)"],
    ["alice@example.org ((x)<bob@example.org>)"],
    ["alice@example.org (a\\)<bob@example.org>)"],
    ['alice@example.org (a"b<bob@example.org>)'],
    ['Alice (") <alice@example.org> (")'],
  ])("reads a comment as a comment in %j", (value) => {
    expect(from(value)).toBe("alice@example.org");
  });

  it.each([
    ["alice@example.org (unterminated"],
    ["alice@example.org (a\\)"],
    ["alice@example.org (a))"],
    ["alice@example.org )"],
    ['"unterminated <alice@example.org>'],
    ['"a\\" <alice@example.org>'],
    ["ali\\ce@example.org"],
  ])("refuses the malformed header %j", (value) => {
    expect(from(value)).toBeNull();
  });

  it.each([
    ["alice@example.org, bob@example.org"],
    ["<alice@example.org>, <bob@example.org>"],
    ["<alice@example.org> <bob@example.org>"],
    ["alice@example.org <bob@example.org>"],
    ['alice@example.org "x" <bob@example.org>'],
    ["<alice@example.org> bob@example.org"],
    ['<alice@example.org> "bob"'],
    ["<<alice@example.org>>"],
    ["friends: alice@example.org;"],
  ])("refuses more than one candidate in %j", (value) => {
    expect(from(value)).toBeNull();
  });

  it.each([
    ['"x".bob@example.org'],
    ['"x"bob@example.org'],
    ['<"x"bob@example.org>'],
    ["bob(x)@example.org"],
    ["ali(x)ce@example.org"],
    ['"a@b.org"'],
    ["Alice"],
    ["<>"],
    [""],
  ])("refuses an address it cannot read in %j", (value) => {
    expect(from(value)).toBeNull();
  });

  it.each([
    ["\u212Aate@example.org"],
    ["Kate <\u212Aate@example.org>"],
    ["kate@\u212Aexample.org"],
    ["jos\u00e9@example.org"],
    ["jose@b\u00fccher.example"],
  ])("refuses the non-ASCII address %j", (value) => {
    expect(from(value)).toBeNull();
  });

  it("refuses anything but one From header", () => {
    expect(fromAddress(undefined)).toBeNull();
    expect(fromAddress([])).toBeNull();
    const one = { name: "From", value: "alice@example.org" };
    expect(fromAddress([one, { name: "from", value: "bob@example.org" }])).toBeNull();
  });
});
