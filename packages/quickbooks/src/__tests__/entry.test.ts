import { describe, expect, it } from "vitest";
import * as entry from "../index";
import * as local from "../local";
import * as oauth from "../oauth";

describe("main entry", () => {
  it("exports nothing from oauth or local: the app never holds the client secret or a token file", () => {
    const keys = Object.keys(entry);
    for (const name of [...Object.keys(oauth), ...Object.keys(local)]) expect(keys).not.toContain(name);
  });
});
