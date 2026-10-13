/**
 * Strips credentials and personal data from integration error text before it
 * leaves the app (alert emails): URLs carrying a query string, email
 * addresses, auth headers and key=value secrets, provider token prefixes, and
 * long opaque strings that look like keys.
 */
const PATTERNS: [RegExp, string][] = [
    [/\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi, "[url]"],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
    [/\b(bearer|basic|zoho-oauthtoken)\s+[^\s"',]+/gi, "$1 [redacted]"],
    [/\b(x-shopify-access-token|authorization|access_token|refresh_token|client_secret|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1$2[redacted]"],
    [/\b(shpat|shpss|shpca|shppa|re|sk|pk)_[A-Za-z0-9_]{8,}/g, "[redacted]"],
    // Mixed letters and digits, so long snake_case identifiers survive.
    [/\b(?=[A-Za-z_-]*\d)(?=[\d_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, "[redacted]"],
];

export function redactSecrets(text: string): string {
    return PATTERNS.reduce((s, [re, sub]) => s.replace(re, sub), text);
}
