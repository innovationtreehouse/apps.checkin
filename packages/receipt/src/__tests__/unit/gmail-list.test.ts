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

  it("names the mailbox it reads", () => {
    expect(createGmailReader("receipts@example.org", async () => "token").address).toBe("receipts@example.org");
  });
});

describe("createGmailReader.getRaw", () => {
  it("fetches the whole message with format=raw and decodes it", async () => {
    const raw = Buffer.from("From: alice@example.org\r\n\r\nhi\xff", "latin1");
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ id: "m/1", raw: raw.toString("base64url"), internalDate: "1700000000000" })));
    vi.stubGlobal("fetch", fetchMock);

    expect(await createGmailReader("receipts@example.org", async () => "token").getRaw("m/1")).toEqual({ raw, internalDate: "1700000000000" });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/gmail/v1/users/receipts%40example.org/messages/m%2F1");
    expect(url.searchParams.get("format")).toBe("raw");
  });

  it("refuses an answer with no raw message as a bug", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "m1", internalDate: "1" })));
    await expect(createGmailReader("receipts@example.org", async () => "token").getRaw("m1")).rejects.toMatchObject({ kind: "bug" });
  });
});
