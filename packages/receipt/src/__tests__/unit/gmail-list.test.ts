import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailReader } from "../../lib/gmail";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGmailReader.listRecent", () => {
  it("uses Gmail's default search, so Spam and Trash are never listed", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ messages: [{ id: "b" }, { id: "a" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const reader = createGmailReader("receipts@example.org", async () => "token");

    expect(await reader.listRecent(3)).toEqual(["a", "b"]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("newer_than:3d -in:sent -in:drafts");
    expect(url.searchParams.has("includeSpamTrash")).toBe(false);
  });
});
