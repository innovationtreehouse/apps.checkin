import { httpError, parseId, readJson } from "@checkin/component-kit";

/** A body's participantId: a JSON number that is a positive int4. */
export function parseParticipantId(raw: unknown): number {
    if (raw === undefined || raw === null) throw httpError(400, "participantId is required");
    if (typeof raw !== "number") throw httpError(400, "Invalid participantId");
    return parseId(String(raw), "participantId");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The request body as a JSON object; anything else is a 400. */
export async function readObjectBody(req: Request): Promise<Record<string, unknown>> {
    const body = await readJson(req);
    if (!isJsonObject(body)) throw httpError(400, "Invalid JSON body");
    return body;
}
