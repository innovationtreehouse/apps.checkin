/**
 * @jest-environment node
 */
/**
 * Flow test for program-session RSVPs, driven over HTTP against a running dev server with a
 * fresh seed: a program's lead adds a session, a member household's lead finds it on their
 * events list and answers for an enrolled youth, and the lead's session roster follows each
 * answer. A household with no one in the program is refused both the RSVP and the roster.
 *
 * Personas: program.lead@example.com (lead of the seeded "Seed: running now" program),
 * program.family@example.com (lead of the household whose two youths are enrolled in it) and
 * parent.family2@example.com (lead of a non-member household with no one enrolled).
 */

import { loginAs, api } from "./helpers";

const PROGRAM = "Seed: running now";

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type MineRow = { id: number; name: string; participant: { id: number; name: string | null }; rsvp: string | null };
type Roster = { id: number; rsvps: { personId: number; status: string }[] };

describe("flow: RSVP to a program session", () => {
    // First hit of each route compiles it under `next dev`, so the test outlasts the 20 s default.
    it("a household lead answers for an enrolled youth and the lead's roster follows", async () => {
        const lead = await loginAs("program.lead@example.com");
        const family = await loginAs("program.family@example.com");
        const outsider = await loginAs("parent.family2@example.com");

        const programs = await api<{ id: number; name: string }[]>(lead, "/api/programs");
        expect(programs.status).toBe(200);
        const program = programs.json.find((p) => p.name === PROGRAM);
        expect(program).toBeDefined();

        // The lead adds a session to their program.
        const name = `Flow RSVP session ${Date.now()}`;
        const created = await api<{ count: number }>(lead, "/api/events", {
            method: "POST",
            body: JSON.stringify({ name, programId: program!.id, startDate: inDays(5), startTime: "18:00", endTime: "20:00" }),
        });
        expect(created.status).toBe(200);
        expect(created.json.count).toBe(1);

        // The family's list shows the session once per enrolled youth, unanswered.
        const mine = async (s: typeof family) => {
            const res = await api<MineRow[]>(s, "/api/events/mine");
            expect(res.status).toBe(200);
            return res.json.filter((row) => row.name === name);
        };
        const rows = await mine(family);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.rsvp)).toEqual([null, null]);
        const eventId = rows[0].id;
        const youthId = rows[0].participant.id;
        const otherYouthId = rows[1].participant.id;

        const rsvp = (s: typeof family, body: Record<string, unknown>) =>
            api<{ rsvp: { personId: number; status: string } }>(s, `/api/events/${eventId}/rsvp`, { method: "PATCH", body: JSON.stringify(body) });
        const roster = async () => {
            const res = await api<Roster>(lead, `/api/events/${eventId}`);
            expect(res.status).toBe(200);
            return res.json.rsvps;
        };
        const answerFor = async (personId: number) => (await mine(family)).find((r) => r.participant.id === personId)?.rsvp;

        expect(await roster()).toEqual([]);

        // Yes for one youth: the family's list and the lead's roster both show it.
        const yes = await rsvp(family, { status: "ATTENDING", participantId: youthId });
        expect(yes.status).toBe(200);
        expect(yes.json.rsvp).toMatchObject({ personId: youthId, status: "ATTENDING" });
        expect(await answerFor(youthId)).toBe("ATTENDING");
        expect(await answerFor(otherYouthId)).toBeNull();
        expect(await roster()).toEqual([expect.objectContaining({ personId: youthId, status: "ATTENDING" })]);

        // Changed to No: the same row updates rather than a second one appearing.
        const no = await rsvp(family, { status: "NOT_ATTENDING", participantId: youthId });
        expect(no.status).toBe(200);
        expect(await answerFor(youthId)).toBe("NOT_ATTENDING");
        expect(await roster()).toEqual([expect.objectContaining({ personId: youthId, status: "NOT_ATTENDING" })]);

        // An unknown answer is refused.
        expect((await rsvp(family, { status: "PERHAPS", participantId: youthId })).status).toBe(400);

        // A household with no one in the program: not on their list, no RSVP for themself or
        // for another household's youth, and no roster.
        expect(await mine(outsider)).toEqual([]);
        expect((await rsvp(outsider, { status: "ATTENDING" })).status).toBe(403);
        expect((await rsvp(outsider, { status: "ATTENDING", participantId: otherYouthId })).status).toBe(403);
        expect((await api(outsider, `/api/events/${eventId}`)).status).toBe(404);

        // The roster is staff-only: the family is refused it too.
        expect((await api(family, `/api/events/${eventId}`)).status).toBe(404);

        // The refused answers left no rows behind.
        expect(await roster()).toEqual([expect.objectContaining({ personId: youthId, status: "NOT_ATTENDING" })]);
    }, 60_000);
});
