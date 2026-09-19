import { getKioskDisplayNames } from "../kiosk-names";

describe("getKioskDisplayNames", () => {
    it("returns first name only for a single participant", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Sarah Johnson", email: "sarah@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah");
    });

    it("returns first names only when all are unique", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Sarah Johnson", email: "sarah@example.com" },
            { id: 2, name: "Mike Smith", email: "mike@example.com" },
            { id: 3, name: "Alex Rivera", email: "alex@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah");
        expect(map.get(2)).toBe("Mike");
        expect(map.get(3)).toBe("Alex");
    });

    it("disambiguates with 1-char last initial when first names collide", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Sarah Miller", email: "sarah.m@example.com" },
            { id: 2, name: "Sarah Kim", email: "sarah.k@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah M.");
        expect(map.get(2)).toBe("Sarah K.");
    });

    it("disambiguates with 2-char last prefix when last initials also collide", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Sarah Morris", email: "sarah.mo@example.com" },
            { id: 2, name: "Sarah Martinez", email: "sarah.ma@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah Mo.");
        expect(map.get(2)).toBe("Sarah Ma.");
    });

    it("handles a mix of unique and colliding first names", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Sarah Morris", email: "sarah.mo@example.com" },
            { id: 2, name: "Sarah Martinez", email: "sarah.ma@example.com" },
            { id: 3, name: "Mike Smith", email: "mike@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah Mo.");
        expect(map.get(2)).toBe("Sarah Ma.");
        expect(map.get(3)).toBe("Mike");
    });

    it("falls back to email prefix when name is null", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: null, email: "jdoe@example.com" },
        ]);
        expect(map.get(1)).toBe("jdoe");
    });

    it("handles 'Last, First' comma format", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Johnson, Sarah", email: "sarah@example.com" },
            { id: 2, name: "Kim, Sarah", email: "sarah.k@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah J.");
        expect(map.get(2)).toBe("Sarah K.");
    });

    it("handles single-word names (no last name)", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Cher", email: "cher@example.com" },
        ]);
        expect(map.get(1)).toBe("Cher");
    });

    it("handles duplicate first names where one has no last name", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Alex", email: "alex1@example.com" },
            { id: 2, name: "Alex Rivera", email: "alex2@example.com" },
        ]);
        expect(map.get(1)).toBe("Alex");
        expect(map.get(2)).toBe("Alex R.");
    });

    it("is case-insensitive for first name grouping", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "sarah Miller", email: "sarah.m@example.com" },
            { id: 2, name: "Sarah Kim", email: "sarah.k@example.com" },
        ]);
        expect(map.get(1)).toBe("sarah M.");
        expect(map.get(2)).toBe("Sarah K.");
    });

    it("initializes the last name, not the middle name", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "John Frank Doe", email: "j1@example.com" },
            { id: 2, name: "John Smith", email: "j2@example.com" },
        ]);
        expect(map.get(1)).toBe("John D.");
        expect(map.get(2)).toBe("John S.");
    });

    it("initializes the final word of a multi-word last name", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Maria De La Cruz", email: "m1@example.com" },
            { id: 2, name: "Maria Diaz", email: "m2@example.com" },
        ]);
        expect(map.get(1)).toBe("Maria C.");
        expect(map.get(2)).toBe("Maria D.");
    });

    it("initializes the final word of a multi-word last name in comma format", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "De La Cruz, Maria", email: "m1@example.com" },
            { id: 2, name: "Diaz, Maria", email: "m2@example.com" },
        ]);
        expect(map.get(1)).toBe("Maria C.");
        expect(map.get(2)).toBe("Maria D.");
    });

    it("handles three-way collision with mixed last initials", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Sarah Morris", email: "s1@example.com" },
            { id: 2, name: "Sarah Martinez", email: "s2@example.com" },
            { id: 3, name: "Sarah Kim", email: "s3@example.com" },
        ]);
        // Morris and Martinez share 'M', so get 2-char; Kim is unique initial
        expect(map.get(1)).toBe("Sarah Mo.");
        expect(map.get(2)).toBe("Sarah Ma.");
        expect(map.get(3)).toBe("Sarah K.");
    });

    it("shows the nickname in place of the first name", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Robert Johnson", nickname: "Bo", email: "rob@example.com" },
        ]);
        expect(map.get(1)).toBe("Bo");
    });

    it("disambiguates colliding nicknames on the last name from `name`", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Robert Miller", nickname: "Bo", email: "r.m@example.com" },
            { id: 2, name: "Bonnie Kim", nickname: "Bo", email: "b.k@example.com" },
        ]);
        expect(map.get(1)).toBe("Bo M.");
        expect(map.get(2)).toBe("Bo K.");
    });

    it("groups a nickname against a matching plain first name", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Robert Miller", nickname: "Sarah", email: "r.m@example.com" },
            { id: 2, name: "Sarah Kim", email: "s.k@example.com" },
        ]);
        expect(map.get(1)).toBe("Sarah M.");
        expect(map.get(2)).toBe("Sarah K.");
    });

    it("takes the nickname from comma-format names too", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Johnson, Robert", nickname: "Bo", email: "r.j@example.com" },
        ]);
        expect(map.get(1)).toBe("Bo");
    });

    it("uses the nickname ahead of the email prefix when there is no name", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: null, nickname: "Bo", email: "rjohnson@example.com" },
        ]);
        expect(map.get(1)).toBe("Bo");
    });

    it("ignores a blank or absent nickname", () => {
        const map = getKioskDisplayNames([
            { id: 1, name: "Robert Johnson", nickname: "   ", email: "r.j@example.com" },
            { id: 2, name: "Mike Smith", nickname: null, email: "m.s@example.com" },
        ]);
        expect(map.get(1)).toBe("Robert");
        expect(map.get(2)).toBe("Mike");
    });
});
