import { isBadEmailChange, isEmailInUseError } from "../emailInUse";

describe("isBadEmailChange", () => {
    it.each([
        ["a malformed new address", "nope", "a@example.com"],
        ["a malformed address over no address", "nope", null],
        ["a number", 42, "a@example.com"],
        ["an object", { set: "a@example.com" }, "a@example.com"],
    ])("refuses %s", (_label, email, stored) => {
        expect(isBadEmailChange(email, stored)).toBe(true);
    });

    it.each([
        ["no email in the request", undefined, "a@example.com"],
        ["a null", null, "a@example.com"],
        ["an empty string", "", "a@example.com"],
        ["only whitespace", "   ", "a@example.com"],
        ["a valid new address", "b@example.com", "a@example.com"],
        ["a stored malformed address resent", "nope", "nope"],
        ["a stored malformed address resent in another case", " NOPE ", "nope"],
    ])("allows %s", (_label, email, stored) => {
        expect(isBadEmailChange(email, stored)).toBe(false);
    });
});

describe("isEmailInUseError", () => {
    const onEmail = { code: "P2002", meta: { target: ["email"] } };

    it("recognises a collision on the email column for a real address", () => {
        expect(isEmailInUseError(onEmail, "A@example.com")).toBe(true);
    });

    it.each([
        ["another column", { code: "P2002", meta: { target: ["googleId"] } }, "a@example.com"],
        ["another error", { code: "P2025" }, "a@example.com"],
        ["an empty string", onEmail, ""],
        ["only whitespace", onEmail, "   "],
        ["no email in the request", onEmail, undefined],
    ])("ignores %s", (_label, error, email) => {
        expect(isEmailInUseError(error, email)).toBe(false);
    });
});
