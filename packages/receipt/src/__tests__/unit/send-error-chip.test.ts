import { beforeEach, describe, expect, it, vi } from "vitest";

const show = vi.hoisted(() => vi.fn());
vi.mock("@mantine/notifications", () => ({ notifications: { show } }));

const { send } = await import("../../components/api");

const respond = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

beforeEach(() => {
  show.mockClear();
  vi.stubGlobal("window", new EventTarget());
});

describe("send()", () => {
  it("raises a red chip that stays, titled with what failed and giving the server's reason", async () => {
    respond(403, JSON.stringify({ error: "You cannot decide on a receipt that you or your household uploaded or is reimbursed for" }));
    expect(await send("/r1/clear-duplicate", "POST", {}, "Cleared", "Couldn't clear the duplicate flag")).toBe(false);
    expect(show).toHaveBeenCalledWith({
      title: "Couldn't clear the duplicate flag",
      message: "You cannot decide on a receipt that you or your household uploaded or is reimbursed for",
      color: "red",
      autoClose: false,
    });
  });

  it("names the HTTP status when the server gives no reason", async () => {
    respond(502, "");
    await send("/settings", "PUT", {}, "Settings saved", "Couldn't save the settings");
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't save the settings", message: "HTTP 502", autoClose: false }));
  });

  it("shows a green chip on success", async () => {
    respond(200, "{}");
    expect(await send("/settings", "PUT", {}, "Settings saved", "Couldn't save the settings")).toBe(true);
    expect(show).toHaveBeenCalledWith({ message: "Settings saved", color: "green" });
  });
});
