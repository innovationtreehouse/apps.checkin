import { REGISTRY } from "../registry";
import { findUnknownTokens, substituteTokens, type TokenSpecs } from "../tokens";

const TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;
const used = (s: string) => [...s.matchAll(TOKEN_RE)].map((m) => m[1]);

describe("email template registry", () => {
    it("holds every templated email", () => {
        expect(Object.keys(REGISTRY)).toHaveLength(37);
    });

    describe.each(Object.entries(REGISTRY))("%s", (_key, spec) => {
        it("has a non-blank default subject and body", () => {
            expect(spec.defaultSubject.trim()).not.toBe("");
            expect(spec.defaultBody.trim()).not.toBe("");
        });

        it("uses only its allowed tokens", () => {
            expect(findUnknownTokens(spec.defaultSubject, spec.allowedTokens)).toEqual([]);
            expect(findUnknownTokens(spec.defaultBody, spec.allowedTokens)).toEqual([]);
        });

        it("uses every allowed token in its defaults", () => {
            const inDefaults = new Set([...used(spec.defaultSubject), ...used(spec.defaultBody)]);
            expect(Object.keys(spec.allowedTokens).filter((t) => !inDefaults.has(t))).toEqual([]);
        });

        it("has a sample value for exactly its allowed tokens", () => {
            expect(Object.keys(spec.sampleCtx).sort()).toEqual(Object.keys(spec.allowedTokens).sort());
        });

        it("keeps link tokens out of the subject", () => {
            const links = Object.entries(spec.allowedTokens as TokenSpecs).filter(([, t]) => t.kind === "link").map(([n]) => n);
            expect(used(spec.defaultSubject).filter((t) => links.includes(t))).toEqual([]);
        });
    });
});

describe("substituteTokens", () => {
    const tokens: TokenSpecs = { name: { kind: "text" }, go: { kind: "link", label: "Open & go" }, raw: { kind: "link" } };

    it("escapes the body's text and values and renders link tokens as anchors", () => {
        const out = substituteTokens("Hi {{name}} <b> {{go}} {{raw}}", { name: "O'Brien <x>", go: "https://a.test/?a=1&b=2", raw: "https://b.test/" }, tokens, { escape: true });
        expect(out).toBe(
            'Hi O&#39;Brien &lt;x&gt; &lt;b&gt; <a href="https://a.test/?a=1&amp;b=2">Open &amp; go</a> <a href="https://b.test/">https://b.test/</a>',
        );
    });

    it("inserts subject values raw", () => {
        expect(substituteTokens("Arts & {{name}}", { name: "O'Brien" }, tokens, { escape: false })).toBe("Arts & O'Brien");
    });

    it("leaves unknown tokens as written and fills missing values with nothing", () => {
        expect(substituteTokens("{{nope}}|{{name}}|{{ name }}", {}, tokens, { escape: false })).toBe("{{nope}}||");
    });

    it("does not resolve inherited object keys as tokens", () => {
        expect(findUnknownTokens("{{constructor}} {{toString}}", tokens)).toEqual(["constructor", "toString"]);
        expect(substituteTokens("{{constructor}}", {}, tokens, { escape: false })).toBe("{{constructor}}");
    });
});
