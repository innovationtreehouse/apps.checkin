import { isPrismaError, uniqueViolationFields } from "@/lib/prismaUniqueViolation";

/** The key two program names collide on within a membership year: trimmed and lower-cased, inner spaces kept. */
export const programNameKey = (name: string): string => name.trim().toLowerCase();

/** The columns a program write sets for a name. Every writer of `Program.name` spreads this. */
export const programNameFields = (name: string) => ({ name: name.trim(), nameKey: programNameKey(name) });

export const PROGRAM_NAME_TAKEN = "A program with this name already exists for that membership year.";

/** A collision on the (nameKey, appliesToYear) unique index. */
export function isProgramNameTaken(error: unknown): boolean {
    return isPrismaError(error, "P2002") && Boolean(uniqueViolationFields(error)?.includes("nameKey"));
}
