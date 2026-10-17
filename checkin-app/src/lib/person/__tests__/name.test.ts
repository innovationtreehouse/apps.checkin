import { nameWrite, nicknameWrite, isNicknameWrite } from "@/lib/person/name";

describe("nameWrite", () => {
    it("trims a real name and rejects blank or non-string input", () => {
        expect(nameWrite("  Jane ")).toBe("Jane");
        expect(nameWrite("   ")).toBeUndefined();
        expect(nameWrite(42)).toBeUndefined();
        expect(nameWrite(undefined)).toBeUndefined();
    });
});

describe("nickname writes", () => {
    it("trims a nickname, clears on blank or null, leaves the stored one on undefined", () => {
        expect(nicknameWrite("  Dave ")).toBe("Dave");
        expect(nicknameWrite("   ")).toBeNull();
        expect(nicknameWrite(null)).toBeNull();
        expect(nicknameWrite(undefined)).toBeUndefined();
    });

    // isNicknameWrite is the routes' 400 gate: a buggy caller sending a number or an
    // object must be refused, not treated as a clear that erases the stored nickname.
    it("refuses a malformed write instead of reading it as a clear", () => {
        expect(isNicknameWrite("Dave")).toBe(true);
        expect(isNicknameWrite("")).toBe(true);
        expect(isNicknameWrite(null)).toBe(true);
        expect(isNicknameWrite(undefined)).toBe(true);
        expect(isNicknameWrite(42)).toBe(false);
        expect(isNicknameWrite({})).toBe(false);
        expect(isNicknameWrite(["Dave"])).toBe(false);
    });
});
