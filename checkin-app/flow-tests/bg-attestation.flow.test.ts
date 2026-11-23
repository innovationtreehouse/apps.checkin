/**
 * @jest-environment node
 */
/**
 * Flow test for background-check attestation (CUJS B5), driven over HTTP against a running
 * dev server with a fresh seed. A newly minted adult with no membership application marks their own
 * check started, which opens their check review. Two reviewers then decide it: the Board
 * approves, the BG reviewer rejects and the review blocks, the rejecter changes their answer
 * (which discards every earlier decision), and a fresh Board approval clears the check.
 * The reviewer queues, the Board's compliance dashboard and the Board's attestation history
 * follow each step.
 *
 * Refused along the way: callers without the reviewer role reading or recording a review,
 * a REJECT with no note, a reviewer attesting twice, anyone but the rejecter reopening a
 * blocked review, and a reviewer deciding their own check. The queue a reviewer reads never
 * names who else decided, and the attestation history is the Board's alone.
 *
 * Personas: a family minted per run through the local dev-persona mint (its lead is the
 * adult checked), bg.reviewer@example.com and boardmember@example.com (the two reviewers, in
 * households of their own) and keyholder1@example.com (no reviewer role).
 */

import { loginAs, api, setBgRecheckMonths, type Session } from "./helpers";

type Rows = { rows: { personId: number; name: string | null; state: string }[] };
type QueueItem = {
    id: number;
    subjectPerson: { id: number; name: string | null } | null;
    _count: { attestations: number };
} & Record<string, unknown>;
type Queue = { queue: QueueItem[] };
type Outcome = { outcome: { status: string; approvals?: number } };
type Attestation = { result: string; reviewer: { id: number; name: string | null }; process: { id: number } };
type Compliance = { peopleWithDisputedCheck: { personId: number; reason: string }[] };

const QUEUE_KEYS = ["_count", "id", "requestedForHousehold", "subjectPerson"];
const SUBJECT_KEYS = ["household", "householdId", "id", "name"];

describe("flow: background-check attestation (CUJS B5)", () => {
    let board: Session;
    let restoreRecheck: () => Promise<void> = async () => {};

    beforeAll(async () => {
        board = await loginAs("boardmember@example.com");
        restoreRecheck = await setBgRecheckMonths(board, 29);
    });
    afterAll(async () => { await restoreRecheck(); });

    /** A new family's lead, declared over 25 so their check may start; signed in. */
    async function mintedAdult(): Promise<Session> {
        const minted = await api<{ personaId: number }>(null, "/api/auth/dev-personas", { method: "POST" });
        expect(minted.status).toBe(200);
        const found = await api<{ people: { id: number; email: string }[] }>(board, `/api/people/search?q=${minted.json.personaId}`);
        const email = found.json.people.find((p) => p.id === minted.json.personaId)?.email;
        expect(email).toBeDefined();
        const adult = await loginAs(email!);
        expect((await api(adult, "/api/profile", { method: "PATCH", body: JSON.stringify({ dob: null, over25: true }) })).status).toBe(200);
        return adult;
    }

    it("an adult starts their check, a rejection blocks it, the rejecter reopens it and two approvals clear it", async () => {
        const subject = await mintedAdult();
        const reviewer = await loginAs("bg.reviewer@example.com");
        const outsider = await loginAs("keyholder1@example.com");

        const queue = async (s: Session, query = "") => {
            const res = await api<Queue>(s, `/api/membership/reviews${query}`);
            expect(res.status).toBe(200);
            return res.json.queue;
        };
        const decide = (s: Session, processId: number, result: "APPROVE" | "REJECT", note?: string) =>
            api<Outcome & { code?: string }>(s, "/api/membership/reviews", { method: "POST", body: JSON.stringify({ processId, result, note }) });
        const history = async (processId: number) => {
            const res = await api<Attestation[]>(board, "/api/membership-audit/bg-attestations");
            expect(res.status).toBe(200);
            return res.json.filter((a) => a.process.id === processId).map((a) => [a.reviewer.id, a.result]).sort();
        };
        const disputed = async () => {
            const res = await api<Compliance>(board, "/api/membership-audit/compliance");
            expect(res.status).toBe(200);
            return res.json.peopleWithDisputedCheck.some((p) => p.personId === subject.personaId && p.reason === "BG_DISPUTED");
        };
        const ownRow = async () => {
            const res = await api<Rows>(subject, "/api/membership/check-started");
            expect(res.status).toBe(200);
            return res.json.rows.find((r) => r.personId === subject.personaId)?.state;
        };

        // The adult marks their own check started; that opens their check review.
        expect(await ownRow()).toBe("NEEDS_MARKING");
        const mark = await api<Rows>(subject, "/api/membership/check-started", { method: "POST", body: JSON.stringify({ personId: subject.personaId }) });
        expect(mark.status).toBe(200);
        expect(await ownRow()).toBe("NOTHING_TO_DO");

        const opened = (await queue(reviewer)).find((q) => q.subjectPerson?.id === subject.personaId);
        expect(opened).toBeDefined();
        const processId = opened!.id;
        expect(opened!._count.attestations).toBe(0);
        // A reviewer sees the person's name and household context, nothing personal.
        expect(Object.keys(opened!).sort()).toEqual(QUEUE_KEYS);
        expect(Object.keys(opened!.subjectPerson!).sort()).toEqual(SUBJECT_KEYS);
        const subjectName = opened!.subjectPerson!.name!;
        expect(subjectName).toMatch(/^New Family \d+$/);

        // Neither the subject nor a member without the reviewer role reads or decides the review.
        for (const s of [subject, outsider]) {
            const read = await api(s, "/api/membership/reviews");
            expect(read.status).toBe(403);
            expect(JSON.stringify(read.json)).not.toContain(subjectName);
            expect((await decide(s, processId, "APPROVE")).status).toBe(403);
        }
        // The attestation history and the compliance dashboard are the Board's.
        for (const s of [subject, outsider, reviewer]) {
            const read = await api(s, "/api/membership-audit/bg-attestations");
            expect(read.status).toBe(403);
            expect(JSON.stringify(read.json)).not.toContain(subjectName);
            expect((await api(s, "/api/membership-audit/compliance")).status).toBe(403);
        }

        // The Board approves first; a second decision by the same reviewer is refused.
        const first = await decide(board, processId, "APPROVE");
        expect(first.status).toBe(200);
        expect(first.json.outcome).toEqual({ status: "PENDING_BG_REVIEW", approvals: 1 });
        const twice = await decide(board, processId, "APPROVE");
        expect(twice.status).toBe(409);
        expect(twice.json.code).toBe("already_attested");
        expect((await queue(board, "?mine=1")).map((q) => q.id)).toContain(processId);

        // The second reviewer sees one approval, never whose.
        const pending = (await queue(reviewer)).find((q) => q.id === processId);
        expect(pending?._count.attestations).toBe(1);
        expect(JSON.stringify(pending)).not.toContain("reviewer");
        expect(JSON.stringify(pending)).not.toContain("Board Member");

        // A rejection needs a note; with one, the review blocks.
        expect((await decide(reviewer, processId, "REJECT")).status).toBe(400);
        const reject = await decide(reviewer, processId, "REJECT", "flow test: the report needs a second look");
        expect(reject.status).toBe(200);
        expect(reject.json.outcome).toEqual({ status: "BLOCKED" });

        expect((await queue(board)).map((q) => q.id)).not.toContain(processId);
        expect((await queue(reviewer, "?rejected=1")).map((q) => q.id)).toContain(processId);
        expect((await queue(board, "?rejected=1")).map((q) => q.id)).not.toContain(processId);
        expect(await disputed()).toBe(true);
        expect(await history(processId)).toEqual([[board.personaId, "APPROVE"], [reviewer.personaId, "REJECT"]].sort());

        // Only the rejecter may reopen a blocked review.
        const boardReopen = await decide(board, processId, "APPROVE");
        expect(boardReopen.status).toBe(409);
        expect(boardReopen.json.code).toBe("wrong_phase");

        // The rejecter changes to approve: every earlier decision goes, and theirs is the first of two.
        const switched = await decide(reviewer, processId, "APPROVE");
        expect(switched.status).toBe(200);
        expect(switched.json.outcome).toEqual({ status: "PENDING_BG_REVIEW", approvals: 1 });
        expect(await history(processId)).toEqual([[reviewer.personaId, "APPROVE"]]);
        expect((await queue(board)).find((q) => q.id === processId)?._count.attestations).toBe(1);

        // A fresh Board approval clears the check.
        const cleared = await decide(board, processId, "APPROVE");
        expect(cleared.status).toBe(200);
        expect(cleared.json.outcome).toEqual({ status: "ACTIVE" });

        expect((await queue(board)).map((q) => q.id)).not.toContain(processId);
        expect((await queue(reviewer, "?mine=1")).map((q) => q.id)).not.toContain(processId);
        expect(await disputed()).toBe(false);
        expect(await history(processId)).toEqual([[board.personaId, "APPROVE"], [reviewer.personaId, "APPROVE"]].sort());
        expect(await ownRow()).toBe("NOTHING_TO_DO");
    }, 60_000);

    it("a reviewer cannot decide their own check, and the Board dismisses the review", async () => {
        const reviewer = await loginAs("bg.reviewer@example.com");

        const mark = await api(reviewer, "/api/membership/check-started", { method: "POST", body: JSON.stringify({ personId: reviewer.personaId }) });
        expect(mark.status).toBe(200);
        const own = (await api<Queue>(board, "/api/membership/reviews")).json.queue.find((q) => q.subjectPerson?.id === reviewer.personaId);
        expect(own).toBeDefined();

        const self = await api<{ code: string }>(reviewer, "/api/membership/reviews", { method: "POST", body: JSON.stringify({ processId: own!.id, result: "APPROVE" }) });
        expect(self.status).toBe(403);
        expect(self.json.code).toBe("same_household_applicant");

        // The review the reviewer cannot decide leaves the queue by a Board dismissal.
        const dismiss = await api(board, "/api/membership/reviews/dismiss", { method: "POST", body: JSON.stringify({ processId: own!.id, reason: "flow test: opened to test the own-check bar" }) });
        expect(dismiss.status).toBe(200);
        expect((await api<Queue>(board, "/api/membership/reviews")).json.queue.map((q) => q.id)).not.toContain(own!.id);
    }, 60_000);
});
