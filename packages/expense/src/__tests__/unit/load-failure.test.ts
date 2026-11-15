/** Which failed finance-queue loads point to the server log, and the status each names, pure — no database. */
import { describe, it, expect } from "vitest";
import { FAILURE_TEXT } from "@checkin/component-ui";
import { loadFailure } from "../../pages/financeQueue";

const server = (status: number) => `GET /x failed on the server (HTTP ${status}); the server log names the cause under that route.`;

describe("loadFailure", () => {
  it("points to the server log with the real status for a 5xx that brought no words of its own", () => {
    expect(loadFailure("/x", FAILURE_TEXT, 500)).toBe(server(500));
    expect(loadFailure("/x", FAILURE_TEXT, 503)).toBe(server(503));
    expect(loadFailure("/x", "Internal Server Error", 500)).toBe(server(500));
  });

  it("names the status for any other wordless answer", () => {
    expect(loadFailure("/x", FAILURE_TEXT, 404)).toBe("GET /x answered: HTTP 404");
    expect(loadFailure("/x", FAILURE_TEXT, 200)).toBe("GET /x answered: HTTP 200");
  });

  it("quotes the answer's own words", () => {
    expect(loadFailure("/x", "Forbidden", 403)).toBe("GET /x answered: Forbidden");
    expect(loadFailure("/x", "The server is unavailable. Try again in a minute.", 502)).toBe("GET /x answered: The server is unavailable. Try again in a minute.");
  });
});
