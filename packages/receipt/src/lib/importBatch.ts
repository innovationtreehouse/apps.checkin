import { z } from "zod";
import { checkReceiptFile } from "./file-type";
import { ImportBatchSchema } from "./schemas";

export interface CheckedImportRow {
  row: z.output<typeof ImportBatchSchema>[number];
  file: Buffer;
  mimeType: string;
}

export type CheckedImportBatch = { ok: true; rows: CheckedImportRow[] } | { ok: false; problems: string[] };

function rowLabel(batch: unknown, index: number): string {
  const raw: unknown = Array.isArray(batch) ? batch[index] : undefined;
  const id = typeof raw === "object" && raw !== null && "importSourceId" in raw && typeof raw.importSourceId === "string" ? raw.importSourceId : "";
  return id ? `row ${index + 1} (${id})` : `row ${index + 1}`;
}

/**
 * Checks a whole import batch before anything is written: every row's fields and file bytes.
 * Any problem refuses the batch; each is named by row and field, every one of them listed.
 */
export function checkImportBatch(batch: unknown): CheckedImportBatch {
  const parsed = ImportBatchSchema.safeParse(batch);
  const byRow = new Map<number, string[]>();
  const general: string[] = [];
  const add = (index: number, problem: string) => byRow.set(index, [...(byRow.get(index) ?? []), problem]);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [first, ...rest] = issue.path;
      if (typeof first === "number") add(first, `${rest.join(".") || "row"}: ${issue.message}`);
      else general.push(issue.message);
    }
  }
  const rows: CheckedImportRow[] = [];
  if (parsed.success) {
    const firstRowOf = new Map<string, number>();
    parsed.data.forEach((row, index) => {
      const first = firstRowOf.get(row.importSourceId);
      if (first === undefined) firstRowOf.set(row.importSourceId, index);
      else add(index, `importSourceId: repeats row ${first + 1}`);
      const file = Buffer.from(row.fileBase64, "base64");
      const check = checkReceiptFile(file, row.mimeType);
      if (check.ok) rows.push({ row, file, mimeType: check.mimeType });
      else add(index, `file: ${check.error}`);
    });
  }

  const problems = [
    ...general.map((p) => `the batch: ${p}`),
    ...[...byRow.entries()].sort(([a], [b]) => a - b).map(([index, list]) => `${rowLabel(batch, index)}: ${list.join(", ")}`),
  ];
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rows };
}
