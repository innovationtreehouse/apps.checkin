/** Which failed finance-queue loads point to the server log, pure — no database. */
import { describe, it, expect } from "vitest";
import { FAILURE_TEXT } from "@checkin/component-ui";
import { loadFailure } from "../../pages/financeQueue";

const SERVER = "GET /x failed on the server (HTTP 500); the server log names the cause under that route.";

describe("loadFailure", () => {
  it("points to the server log for a 5xx that brought no words of its own", () => {
    expect(loadFailure("/x", FAILURE_TEXT, 500)).toBe(SERVER);
    expect(loadFailure("/x", "Internal Server Error", 500)).toBe(SERVER);
  });

  it("quotes the answer for anything else", () => {
    expect(loadFailure("/x", FAILURE_TEXT, 200)).toBe(`GET /x answered: ${FAILURE_TEXT}`);
    expect(loadFailure("/x", "Forbidden", 403)).toBe("GET /x answered: Forbidden");
    expect(loadFailure("/x", "The server is unavailable. Try again in a minute.", 502)).toBe("GET /x answered: The server is unavailable. Try again in a minute.");
  });
});
