import type { ToolLevel } from "@/generated/prisma/client";
import { findCollisions, type KeepSubject, type MergeSubject } from "../plan";

type ToolRow = { toolId: number; level: ToolLevel; name: string };

function subject(id: number, tools: ToolRow[]) {
    return {
        id,
        programParticipants: [],
        programVolunteers: [],
        rsvps: [],
        toolStatuses: tools.map(t => ({ personId: id, toolId: t.toolId, level: t.level, tool: { name: t.name } })),
        bgAttestations: [],
        bgAttestationsAsSubject: [],
        corporationLeads: [],
        corporationMembers: [],
        roles: [],
    };
}

function collide(keepTools: ToolRow[], mergeTools: ToolRow[]) {
    const keep = subject(1, keepTools) as unknown as KeepSubject;
    const merge = subject(2, mergeTools) as unknown as MergeSubject;
    return findCollisions(keep, merge, { keep: false, merge: false }, new Date());
}

describe("findCollisions — tool certifications", () => {
    it("lets a same-tool, same-level pair through", () => {
        expect(collide(
            [{ toolId: 7, level: "CERTIFIED", name: "Lathe" }],
            [{ toolId: 7, level: "CERTIFIED", name: "Lathe" }],
        )).toEqual([]);
    });

    it("refuses a same-tool pair at different levels", () => {
        expect(collide(
            [{ toolId: 7, level: "BASIC", name: "Lathe" }],
            [{ toolId: 7, level: "INSTRUCTOR", name: "Lathe" }],
        )).toEqual([{ type: "toolStatus", message: "Both hold a Lathe certification at different levels. Remove one first." }]);
    });

    it("lets certifications on different tools through", () => {
        expect(collide(
            [{ toolId: 7, level: "BASIC", name: "Lathe" }],
            [{ toolId: 8, level: "INSTRUCTOR", name: "Bandsaw" }],
        )).toEqual([]);
    });
});
