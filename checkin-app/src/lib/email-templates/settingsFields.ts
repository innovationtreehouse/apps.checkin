import prisma from "@/lib/prisma";
import { REGISTRY, type TemplateKey } from "./registry";
import { findUnknownTokens } from "./tokens";

/**
 * The settings/outreach and settings/email pages edit template copy as
 * BoardSettings-named fields. These map each field onto the `EmailTemplate`
 * rows it reads from (the first target) and writes to (every target).
 */
export type FieldTargets<F extends string> = Record<F, { key: TemplateKey; part: "subject" | "body" }[]>;

/** Why `data` cannot be saved: the first `{{token}}` a field uses that one of its emails does not have. */
export function unknownTokenError<F extends string>(targets: FieldTargets<F>, data: Partial<Record<F, string | null>>): string | null {
    for (const field of Object.keys(data) as F[]) {
        for (const { key } of targets[field]) {
            const [unknown] = findUnknownTokens(data[field] ?? "", REGISTRY[key].allowedTokens);
            if (unknown) return `${field} uses {{${unknown}}}, which ${key} does not have`;
        }
    }
    return null;
}

/** Each field's saved copy, or null when its row or part is missing or blank. */
export async function readTemplateFields<F extends string>(targets: FieldTargets<F>): Promise<Record<F, string | null>> {
    const keys = [...new Set(Object.values<FieldTargets<F>[F]>(targets).flat().map((t) => t.key))];
    const rows = await prisma.emailTemplate.findMany({ where: { key: { in: keys } }, select: { key: true, subject: true, body: true } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const out = {} as Record<F, string | null>;
    for (const field of Object.keys(targets) as F[]) {
        const [first] = targets[field];
        const value = byKey.get(first.key)?.[first.part] ?? "";
        out[field] = value.trim() ? value : null;
    }
    return out;
}

/**
 * Save the fields given in `data` that differ from their saved copy, so a page that
 * posts every field leaves untouched copy alone. A row left with a blank subject
 * and body is removed, which sends the registry default.
 */
export async function writeTemplateFields<F extends string>(
    targets: FieldTargets<F>,
    data: Partial<Record<F, string | null>>,
    updatedBy: number,
): Promise<void> {
    const current = await readTemplateFields(targets);
    const changes = new Map<TemplateKey, { subject?: string; body?: string }>();
    for (const field of Object.keys(data) as F[]) {
        if (data[field] === undefined) continue;
        const value = data[field] ?? "";
        if (value === (current[field] ?? "")) continue;
        for (const { key, part } of targets[field]) changes.set(key, { ...changes.get(key), [part]: value });
    }
    for (const [key, change] of changes) {
        const row = await prisma.emailTemplate.findUnique({ where: { key }, select: { subject: true, body: true } });
        const subject = change.subject ?? row?.subject ?? "";
        const body = change.body ?? row?.body ?? "";
        if (!subject.trim() && !body.trim()) {
            await prisma.emailTemplate.deleteMany({ where: { key } });
            continue;
        }
        await prisma.emailTemplate.upsert({ where: { key }, create: { key, subject, body, updatedBy }, update: { subject, body, updatedBy } });
    }
}
