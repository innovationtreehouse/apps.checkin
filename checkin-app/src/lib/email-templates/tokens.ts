import { escapeHtml } from "./base";

/**
 * Per-key `{{token}}` substitution for editable email templates. Dependency-free
 * (escapeHtml only) so the admin preview can import it client-side and render
 * exactly what the send path renders.
 */

export type TokenKind = "text" | "link";

/** `label` is the fixed anchor text of a link token; without one the URL is shown. */
export interface TokenSpec {
    kind: TokenKind;
    label?: string;
}

export type TokenSpecs = Record<string, TokenSpec>;

const TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** Every `{{token}}` name in `text` that `tokens` does not allow. */
export function findUnknownTokens(text: string, tokens: TokenSpecs): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(TOKEN_RE)) {
        if (!Object.hasOwn(tokens, m[1])) found.add(m[1]);
    }
    return [...found];
}

/**
 * Replace the allowed tokens with their `ctx` values (missing → ""). With
 * `escape` (the body) the template text and every value are HTML-escaped and a
 * link token becomes an anchor; without it (the subject, which is not HTML)
 * everything is inserted raw and a link token is its URL. Unknown tokens are
 * left as written; save-time validation rejects them.
 */
export function substituteTokens(
    template: string,
    ctx: Record<string, string>,
    tokens: TokenSpecs,
    { escape }: { escape: boolean },
): string {
    let out = "";
    let last = 0;
    for (const m of template.matchAll(TOKEN_RE)) {
        out += escape ? escapeHtml(template.slice(last, m.index)) : template.slice(last, m.index);
        last = m.index + m[0].length;
        const spec = Object.hasOwn(tokens, m[1]) ? tokens[m[1]] : undefined;
        if (!spec) {
            out += escape ? escapeHtml(m[0]) : m[0];
            continue;
        }
        const value = Object.hasOwn(ctx, m[1]) ? ctx[m[1]] : "";
        if (!escape) out += value;
        else if (spec.kind === "link") out += `<a href="${escapeHtml(value)}">${escapeHtml(spec.label ?? value)}</a>`;
        else out += escapeHtml(value);
    }
    out += escape ? escapeHtml(template.slice(last)) : template.slice(last);
    return out;
}

/**
 * Turn an already substituted and escaped body into HTML: a blank line starts a
 * paragraph, a single newline is a `<br>`, and a paragraph left empty by its
 * tokens is dropped.
 */
export function renderBodyHtml(substitutedBody: string): string {
    return substitutedBody
        .replace(/\r\n?/g, "\n")
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0)
        .map((paragraph) => `<p>${paragraph.split("\n").map((line) => line.trim()).join("<br>")}</p>`)
        .join("");
}
