import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");
const SKIP = new Set(["__tests__", "generated", "pages", "components"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sources(join(dir, entry.name));
    return entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [];
  });
}

const files = sources(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const lines = files.flatMap(({ path, text }) => text.split("\n").map((line) => ({ path, line: line.trim() })));

/** These put a live person into a write, a view or a destructure; they filter nothing. */
const NOT_A_FILTER = [
  { path: "services/receiptService.ts", line: "? { needsReimbursement, reimbursementFor: actor.name ?? `${actor.firstName} ${actor.lastName}`, reimburseePersonId: actor.id }" },
  { path: "services/receiptService.ts", line: '{ reimburseePersonId: personId, newReimbursee }: Pick<z.output<typeof UploadInputSchema>, "reimburseePersonId" | "newReimbursee">,' },
  { path: "services/receiptService.ts", line: "...sent.map((r) => confirmationView({ ...r, reimburseePersonId: actor.id }, false, mine.sent.get(r.id) ?? []))," },
  { path: "services/receiptService.ts", line: "reimburseePersonId: actor.id," },
];
const sameLine = (a: { path: string; line: string }, b: { path: string; line: string }) => a.path === b.path && a.line === b.line;

describe("a stored person id is read only through the live-people resolver", () => {
  it("a file that selects a person column passes the rows through withLivePeople", () => {
    const skipping = files
      .filter(({ text }) => /\b(uploadedByUserId|reimburseePersonId|reviewedByUserId): true\b/.test(text) && !text.includes("withLivePeople("))
      .map(({ path }) => path);
    expect(skipping).toEqual([]);
  });

  it("rows selected whole come only from the repository, which resolves them", () => {
    const whole = files
      .filter(({ path, text }) => path !== "repositories/receipt.ts" && /\b(db|tx)\.receipt\.find\w+\(\{[^}]*\}\s*\)/.test(text))
      .map(({ path }) => path);
    expect(whole).toEqual([]);
  });

  it("a filter on a person column matches every id stored for the person, not one id", () => {
    const oneId = lines
      .filter(({ line }) => /\b(uploadedByUserId|reimburseePersonId): (\{ (not|equals): )?(actor\.id|personId|viewerId)\b/.test(line))
      .filter((found) => !NOT_A_FILTER.some((allowed) => sameLine(allowed, found)))
      .map(({ path, line }) => `${path}: ${line}`);
    expect(oneId).toEqual([]);
  });

  it("every exemption above names exactly one line of its file", () => {
    for (const allowed of NOT_A_FILTER) expect(lines.filter((found) => sameLine(allowed, found)), allowed.line).toHaveLength(1);
  });
});
