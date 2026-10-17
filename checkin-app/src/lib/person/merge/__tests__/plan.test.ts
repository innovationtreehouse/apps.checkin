import {
    hasIdentity,
    parseFieldChoices,
    planKeeperUpdate,
    resolveKeeperUpdate,
    roleMirrors,
    valuesConflict,
    type MergeFields,
} from "../plan";

function fields(overrides: Partial<MergeFields> = {}): MergeFields {
    return {
        name: "Sam Rivera",
        phone: null,
        dateOfBirth: null,
        image: null,
        email: null,
        googleId: null,
        emailVerified: null,
        emailSuppressed: false,
        lastBackgroundCheck: null,
        lastWaiverSign: null,
        ...overrides,
    };
}

describe("valuesConflict", () => {
    it("is a conflict only when both sides are set and differ", () => {
        expect(valuesConflict("a", "b")).toBe(true);
        expect(valuesConflict("a", "a")).toBe(false);
        expect(valuesConflict(null, "b")).toBe(false);
        expect(valuesConflict("", "b")).toBe(false);
    });

    it("compares dates by instant", () => {
        expect(valuesConflict(new Date("2020-01-01"), new Date("2020-01-01"))).toBe(false);
        expect(valuesConflict(new Date("2020-01-01"), new Date("2021-01-01"))).toBe(true);
    });
});

describe("hasIdentity", () => {
    it("is true when either email or googleId is set", () => {
        expect(hasIdentity({ email: "a@example.com", googleId: null })).toBe(true);
        expect(hasIdentity({ email: null, googleId: "g1" })).toBe(true);
        expect(hasIdentity({ email: "", googleId: null })).toBe(false);
    });
});

describe("resolveKeeperUpdate", () => {
    it("backfills a field only the merged-away record has, image included", () => {
        const data = resolveKeeperUpdate(fields(), fields({ phone: "555-0100", image: "pic.png" }), {});
        expect(data).toEqual({ phone: "555-0100", image: "pic.png" });
    });

    it("writes a conflicting field only when the choice is 'merge'", () => {
        const keep = fields({ name: "Sam" });
        const merge = fields({ name: "Samuel" });
        expect(resolveKeeperUpdate(keep, merge, { name: "keep" })).toEqual({});
        expect(resolveKeeperUpdate(keep, merge, { name: "merge" })).toEqual({ name: "Samuel" });
    });

    it("never takes a conflicting image from the other side", () => {
        expect(resolveKeeperUpdate(fields({ image: "a.png" }), fields({ image: "b.png" }), {})).toEqual({});
    });

    it("moves the whole login identity as one unit, suppression with it", () => {
        const verified = new Date("2024-05-01");
        const keep = fields({ email: "old@example.com", googleId: "g-keep" });
        const merge = fields({ email: "new@example.com", googleId: null, emailVerified: verified, emailSuppressed: true });
        expect(resolveKeeperUpdate(keep, merge, { identity: "merge" })).toEqual({
            email: "new@example.com",
            googleId: null,
            emailVerified: verified,
            emailSuppressed: true,
        });
        expect(resolveKeeperUpdate(keep, merge, { identity: "keep" })).toEqual({});
    });

    it("adopts the merged-away identity when the keeper has none", () => {
        const data = resolveKeeperUpdate(fields(), fields({ googleId: "g-merge" }), {});
        expect(data).toMatchObject({ email: null, googleId: "g-merge" });
    });

    it("takes the newer compliance date and never an older one", () => {
        const older = new Date("2023-01-01");
        const newer = new Date("2024-01-01");
        expect(resolveKeeperUpdate(fields({ lastBackgroundCheck: older }), fields({ lastBackgroundCheck: newer }), {}))
            .toEqual({ lastBackgroundCheck: newer });
        expect(resolveKeeperUpdate(fields({ lastWaiverSign: newer }), fields({ lastWaiverSign: older }), {}))
            .toEqual({});
    });
});

describe("parseFieldChoices", () => {
    it("treats a missing fieldChoices as no choices", () => {
        expect(parseFieldChoices(fields(), fields(), undefined)).toEqual({ choices: {} });
    });

    it("refuses a non-object, an unknown key, or a value other than keep/merge", () => {
        expect(parseFieldChoices(fields(), fields(), [])).toEqual({ error: "Invalid fieldChoices" });
        expect(parseFieldChoices(fields(), fields(), "keep")).toEqual({ error: "Invalid fieldChoices" });
        expect(parseFieldChoices(fields(), fields(), { email: "keep" })).toEqual({ error: "Unknown field choice: email" });
        expect(parseFieldChoices(fields(), fields(), { name: "both" }))
            .toEqual({ error: "Invalid choice for name: must be 'keep' or 'merge'" });
    });

    it("requires a choice for every recomputed conflict", () => {
        expect(parseFieldChoices(fields({ phone: "1" }), fields({ phone: "2" }), {}))
            .toEqual({ error: "Choose a value for phone" });
        expect(parseFieldChoices(fields({ email: "a@example.com" }), fields({ googleId: "g" }), {}))
            .toEqual({ error: "Choose a value for identity" });
        expect(parseFieldChoices(fields({ phone: "1" }), fields({ phone: "2" }), { phone: "merge" }))
            .toEqual({ choices: { phone: "merge" } });
    });
});

describe("planKeeperUpdate", () => {
    it("returns the keeper update when a sign-in survives", () => {
        expect(planKeeperUpdate(fields({ email: "a@example.com" }), fields({ phone: "1" }), {}))
            .toEqual({ data: { phone: "1" } });
    });

    it("lets a merge with no login identity on either side through", () => {
        expect(planKeeperUpdate(fields(), fields(), {})).toEqual({ data: {} });
    });
});

describe("roleMirrors", () => {
    it("sets each legacy mirror from the held role set", () => {
        const none = roleMirrors(new Set());
        expect(Object.values(none).every(v => v === false)).toBe(true);
        expect(roleMirrors(new Set(["BOARD"]))).toMatchObject({ isBoardMember: true, isKeyholder: false });
    });
});
