/** The body reads of a stubbed `Response`: `useLoad` reads `text()`, a write reads `json()`. */
export function jsonBody(body: unknown) {
    return { json: async () => body, text: async () => JSON.stringify(body) };
}
