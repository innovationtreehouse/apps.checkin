import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MAX_BODY_BYTES, parseBodyCapped } from "../../routes/_shared";

const schema = z.object({ note: z.string() });

/** A request whose body arrives as a stream with no content-length, as a chunked upload does. */
function streamed(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 4096) controller.enqueue(bytes.slice(i, i + 4096));
      controller.close();
    },
  });
  return new Request("http://test/x", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("parseBodyCapped reads at most 64 KB", () => {
  it("names the refused field on a schema failure, not its value", async () => {
    const err = await parseBodyCapped(streamed(JSON.stringify({ note: 7 })), schema).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, fields: ["note"] });
  });

  it("parses a body under the cap", async () => {
    await expect(parseBodyCapped(streamed(JSON.stringify({ note: "ok" })), schema)).resolves.toEqual({ note: "ok" });
  });

  it("refuses a declared length over the cap without reading", async () => {
    const req = new Request("http://test/x", { method: "POST", body: "{}", headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
    await expect(parseBodyCapped(req, schema)).rejects.toMatchObject({ status: 413 });
  });

  it("stops a streamed body as soon as it passes the cap", async () => {
    await expect(parseBodyCapped(streamed(JSON.stringify({ note: "x".repeat(MAX_BODY_BYTES) })), schema)).rejects.toMatchObject({ status: 413 });
  });

  it("is 400 for a body that is not JSON", async () => {
    await expect(parseBodyCapped(streamed("not json"), schema)).rejects.toMatchObject({ status: 400 });
  });
});
