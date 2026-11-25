/**
 * @jest-environment node
 */
/**
 * Flow test for renewal outreach (CUJS A2 step 1, the manual outreach), driven over HTTP against
 * a running dev server with a fresh seed. The Board saves the opening email's copy and test-sends
 * it to itself; an operations member creates the opening send, which snapshots the leads of ACTIVE
 * households; one lead says the household won't renew before the send drains; the drain emails
 * every other snapshotted lead exactly once and skips that one; a retry sends nothing twice.
 *
 * Refused along the way: a member with no outreach role on every outreach route (their refused
 * send creates nothing), operations editing the copy or test-sending, copy with an unknown token
 * (nothing saved), an unknown email type, and a second send while one is in flight.
 *
 * Personas: three families minted per run through the local dev-persona mint — two activated
 * through intake, the Board's manual contract mark, two check reviews and the dev orders/paid
 * stand-in, one left with no membership — plus boardmember@example.com (Board, sysadmin and first
 * reviewer), bg.reviewer@example.com (second reviewer), keyholder1@example.com (no outreach role)
 * and the address of renewal.partner@example.com (non-lead adult of an ACTIVE seeded household).
 *
 * Emails are captured to the DevSentEmail table (no RESEND_API_KEY in the flow env) and read with
 * a raw `pg` pool, as membership-activation-fanout does; this needs DATABASE_URL. The send also
 * emails the seeded ACTIVE leads; the subject carries a per-run tag so only this run's mail counts.
 *
 * Not driven: a failed delivery and its retry (dev capture never fails a send), the reminder
 * email's audience, and the missing-boundary refusal (the seed sets the boundary, and clearing it
 * would change every other file's membership year).
 */

import { Pool } from "pg";
import { loginAs, api, queuedReviewFor, setBgRecheckMonths, type Session } from "./helpers";

type Copy = {
    outreachOpeningSubject: string | null;
    outreachOpeningBody: string | null;
    outreachReminderSubject: string | null;
    outreachReminderBody: string | null;
};
type OutreachSettings = { settings: Copy; nextDeadline: string | null };
type BulkSend = { id: number; emailType: string; audience: string; senderId: number; startedAt: string; completedAt: string | null };
type Counts = Record<"queued" | "sent" | "failed" | "skipped_denied" | "skipped_not_member" | "skipped_not_audience" | "sending" | "total", number>;
type Summary = BulkSend & { counts: Counts };
type Status = { inFlight: Summary | null; lastCompleted: Summary | null };
type Created = { bulkSend: BulkSend; counts: { queued: number; leadsWithoutEmail: number; total: number } };
type Batch = { bulkSendId: number; processed: number; remaining: number };

const BULK_SEND_KEYS = ["audience", "completedAt", "emailType", "id", "senderId", "startedAt"];
const COUNT_KEYS = ["failed", "queued", "sending", "sent", "skipped_denied", "skipped_not_audience", "skipped_not_member", "total"];
const keys = (o: object) => Object.keys(o).sort();

describe("flow: renewal outreach (CUJS A2)", () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const tag = `flow-${Date.now()}`;
    const subject = `Renewal open ${tag}`;
    let board: Session;
    let originalCopy: Copy | null = null;
    let restoreRecheck: () => Promise<void> = async () => {};

    const status = async (s: Session) => {
        const res = await api<Status>(s, "/api/outreach/status");
        expect(res.status).toBe(200);
        return res.json;
    };
    /** Drains a send batch by batch until nothing is queued. */
    const drain = async (s: Session, bulkSendId: number) => {
        for (let i = 0; i < 50; i++) {
            const batch = await api<Batch>(s, "/api/outreach/process-batch", { method: "POST", body: JSON.stringify({ bulkSendId }) });
            expect(batch.status).toBe(200);
            if (batch.json.remaining === 0) return;
        }
        throw new Error(`send ${bulkSendId} still queued after 50 batches`);
    };
    const mailTo = async (to: string, subj: string) =>
        (await pool.query<{ html: string }>('SELECT html FROM "DevSentEmail" WHERE "to" = $1 AND subject = $2', [to, subj])).rows;
    const runMail = async () =>
        (await pool.query<{ to: string }>('SELECT "to" FROM "DevSentEmail" WHERE subject = $1', [subject])).rows.map((r) => r.to);

    beforeAll(async () => {
        board = await loginAs("boardmember@example.com");
        restoreRecheck = await setBgRecheckMonths(board, 29);
        const before = await api<OutreachSettings>(board, "/api/settings/outreach");
        expect(before.status).toBe(200);
        originalCopy = before.json.settings;
        // A send left in flight by an earlier run against the same database would 409 this one.
        const leftover = (await status(board)).inFlight;
        if (leftover) await drain(board, leftover.id);
    });

    afterAll(async () => {
        await restoreRecheck();
        if (originalCopy) await api(board, "/api/settings/outreach", { method: "PUT", body: JSON.stringify(originalCopy) });
        await pool.end();
    });

    /** A new family's lead, declared over 25 so their check may start; signed in. */
    async function mintedLead(): Promise<Session & { email: string }> {
        const minted = await api<{ personaId: number }>(null, "/api/auth/dev-personas", { method: "POST" });
        expect(minted.status).toBe(200);
        const found = await api<{ people: { id: number; email: string }[] }>(board, `/api/people/search?q=${minted.json.personaId}`);
        const email = found.json.people.find((p) => p.id === minted.json.personaId)?.email;
        expect(email).toBeDefined();
        const lead = await loginAs(email!);
        expect((await api(lead, "/api/profile", { method: "PATCH", body: JSON.stringify({ dob: null, over25: true }) })).status).toBe(200);
        return { ...lead, email: email! };
    }

    /** Takes a minted lead's household from application to an ACTIVE membership. */
    async function activate(lead: Session, reviewer2: Session): Promise<void> {
        expect([200, 201]).toContain((await api(lead, "/api/membership", { method: "POST" })).status);
        const save = await api(lead, "/api/membership/intake", {
            method: "PATCH",
            body: JSON.stringify({
                household: { line1: "5 Outreach Row", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" },
                primaryParent: { name: "Outreach Lead" },
            }),
        });
        expect(save.status).toBe(200);
        expect((await api(lead, "/api/membership/intake/submit", { method: "POST" })).status).toBe(200);
        const own = await api<{ process: { id: number; status: string } | null }>(lead, "/api/membership");
        expect(own.json.process?.status).toBe("PENDING_EXTERNAL_ACTION");
        const processId = own.json.process!.id;

        const mark = await api(board, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-contract" }) });
        expect(mark.status).toBe(200);
        expect((await api(lead, "/api/membership/check-started", { method: "POST", body: JSON.stringify({ personId: lead.personaId }) })).status).toBe(200);

        const queued = await queuedReviewFor(board, lead.personaId);
        expect(queued).toBeDefined();
        for (const reviewer of [board, reviewer2]) {
            const approve = await api(reviewer, "/api/membership/reviews", {
                method: "POST",
                body: JSON.stringify({ processId: queued!.id, result: "APPROVE", subjectPersonIds: [lead.personaId] }),
            });
            expect(approve.status).toBe(200);
        }

        const pay = await api<{ status: string | null }>(lead, "/api/dev/shopify/orders-paid", { method: "POST", body: JSON.stringify({ processId }) });
        expect(pay.status).toBe(200);
        expect(pay.json.status).toBe("ACTIVE");
        expect((await api<{ membershipStatus: string | null }>(lead, "/api/membership")).json.membershipStatus).toBe("ACTIVE");
    }

    // Two activations and the drain each pay first-compile costs under `next dev`.
    it("the Board writes and tests the copy, operations sends it, the drain emails each lead once and skips a lead who won't renew", async () => {
        const reviewer2 = await loginAs("bg.reviewer@example.com");
        const outsider = await loginAs("keyholder1@example.com");
        const operator = await mintedLead();
        const leaving = await mintedLead();
        const nonMember = await mintedLead();
        await activate(operator, reviewer2);
        await activate(leaving, reviewer2);

        const grant = await api(board, "/api/roles", { method: "PATCH", body: JSON.stringify({ targetUserId: operator.personaId, isOperations: true, acknowledgeCheck: true }) });
        expect(grant.status).toBe(200);

        // A member with no outreach role is refused every outreach route, and their send creates nothing.
        const outsiderCalls: [string, RequestInit][] = [
            ["/api/outreach/status", {}],
            ["/api/outreach/status", { method: "POST", body: JSON.stringify({ action: "retry", bulkSendId: 1 }) }],
            ["/api/outreach/send", { method: "POST", body: JSON.stringify({ emailType: "opening" }) }],
            ["/api/outreach/process-batch", { method: "POST", body: "{}" }],
            ["/api/outreach/test-send", { method: "POST", body: JSON.stringify({ emailType: "opening" }) }],
            ["/api/settings/outreach", {}],
            ["/api/settings/outreach", { method: "PUT", body: JSON.stringify({ outreachOpeningSubject: "Hijacked" }) }],
        ];
        for (const [path, init] of outsiderCalls) {
            const res = await api(outsider, path, init);
            expect({ path, method: init.method ?? "GET", status: res.status }).toEqual({ path, method: init.method ?? "GET", status: 403 });
        }
        expect((await status(board)).inFlight).toBeNull();

        // The Board saves the opening copy; the deadline is the boundary's next occurrence.
        const body = "Hi {{name}}, renew by {{deadline}} at {{actionLink}}";
        const put = await api<{ settings: Copy }>(board, "/api/settings/outreach", {
            method: "PUT",
            body: JSON.stringify({ outreachOpeningSubject: subject, outreachOpeningBody: body }),
        });
        expect(put.status).toBe(200);
        expect(put.json.settings).toMatchObject({ outreachOpeningSubject: subject, outreachOpeningBody: body });

        // Copy with a token outside {name, deadline, actionLink} is refused whole.
        const bad = await api(board, "/api/settings/outreach", {
            method: "PUT",
            body: JSON.stringify({ outreachOpeningSubject: "Changed", outreachOpeningBody: "Hi {{email}}" }),
        });
        expect(bad.status).toBe(400);
        const saved = await api<OutreachSettings>(board, "/api/settings/outreach");
        expect(keys(saved.json)).toEqual(["nextDeadline", "settings"]);
        expect(saved.json.settings).toMatchObject({ outreachOpeningSubject: subject, outreachOpeningBody: body });
        const deadline = saved.json.nextDeadline;
        expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // The test send goes to the caller alone, with the sample name and the real deadline.
        expect((await api(board, "/api/outreach/test-send", { method: "POST", body: JSON.stringify({ emailType: "opening", subject, body: "Hi {{bogus}}" }) })).status).toBe(400);
        const test = await api(board, "/api/outreach/test-send", { method: "POST", body: JSON.stringify({ emailType: "opening", subject, body }) });
        expect(test.status).toBe(200);
        const testMail = await mailTo("boardmember@example.com", `[Test] ${subject}`);
        expect(testMail).toHaveLength(1);
        expect(testMail[0].html).toContain("Jordan Rivera");
        expect(testMail[0].html).toContain(deadline!);
        expect(await runMail()).toEqual([]);

        // Operations may read the copy and send it, but not change it or test-send it.
        expect((await api(operator, "/api/settings/outreach")).status).toBe(200);
        expect((await api(operator, "/api/settings/outreach", { method: "PUT", body: JSON.stringify({ outreachOpeningSubject: "Ops copy" }) })).status).toBe(403);
        expect((await api(operator, "/api/outreach/test-send", { method: "POST", body: JSON.stringify({ emailType: "opening" }) })).status).toBe(403);
        expect((await api(operator, "/api/outreach/send", { method: "POST", body: JSON.stringify({ emailType: "renewal" }) })).status).toBe(400);

        // Creating the send snapshots the audience as queued items; nothing is emailed yet.
        const created = await api<Created>(operator, "/api/outreach/send", { method: "POST", body: JSON.stringify({ emailType: "opening" }) });
        expect(created.status).toBe(201);
        expect(keys(created.json)).toEqual(["bulkSend", "counts"]);
        expect(keys(created.json.bulkSend)).toEqual(BULK_SEND_KEYS);
        expect(created.json.bulkSend).toMatchObject({ emailType: "opening", senderId: operator.personaId, completedAt: null });
        expect(created.json.counts.queued).toBeGreaterThanOrEqual(2);
        expect(created.json.counts.total).toBe(created.json.counts.queued);
        const bulkSendId = created.json.bulkSend.id;
        expect(await runMail()).toEqual([]);

        // One send at a time.
        expect((await api(board, "/api/outreach/send", { method: "POST", body: JSON.stringify({ emailType: "opening" }) })).status).toBe(409);

        const pending = (await status(operator)).inFlight!;
        expect(keys(pending)).toEqual([...BULK_SEND_KEYS, "counts"].sort());
        expect(keys(pending.counts)).toEqual(COUNT_KEYS);
        expect(pending).toMatchObject({ id: bulkSendId, counts: { queued: created.json.counts.queued, sent: 0, total: created.json.counts.queued } });

        // Before the drain, one snapshotted lead says the household won't renew.
        expect((await api(leaving, "/api/membership/not-renewing", { method: "POST" })).status).toBe(200);

        await drain(operator, bulkSendId);

        const after = await status(board);
        expect(after.inFlight).toBeNull();
        expect(after.lastCompleted?.id).toBe(bulkSendId);
        expect(after.lastCompleted?.completedAt).not.toBeNull();
        const counts = after.lastCompleted!.counts;
        expect(counts).toMatchObject({ queued: 0, sending: 0, failed: 0, total: created.json.counts.queued });
        expect(counts.skipped_not_audience).toBeGreaterThanOrEqual(1);
        expect(counts.sent + counts.skipped_denied + counts.skipped_not_member + counts.skipped_not_audience).toBe(counts.total);

        // Each sent item is exactly one email, and only to the leads the send kept.
        const sent = await runMail();
        expect(sent).toHaveLength(counts.sent);
        expect(new Set(sent).size).toBe(sent.length);
        const operatorMail = await mailTo(operator.email, subject);
        expect(operatorMail).toHaveLength(1);
        expect(operatorMail[0].html).toContain(deadline!);
        expect(operatorMail[0].html).toContain("/membership");
        expect(sent).not.toContain(leaving.email);
        expect(sent).not.toContain(nonMember.email);
        expect(sent).not.toContain("renewal.partner@example.com");

        // A drained send has nothing left to process.
        expect((await api(operator, "/api/outreach/process-batch", { method: "POST", body: JSON.stringify({ bulkSendId }) })).status).toBe(404);

        // A retry with nothing failed re-sends no one.
        expect((await api(board, "/api/outreach/status", { method: "POST", body: JSON.stringify({ action: "retry", bulkSendId: 2_000_000_000 }) })).status).toBe(404);
        expect((await api(board, "/api/outreach/status", { method: "POST", body: JSON.stringify({ action: "retry", bulkSendId }) })).status).toBe(200);
        const reopened = (await status(board)).inFlight;
        if (reopened) await drain(board, reopened.id);
        expect((await status(board)).lastCompleted).toMatchObject({ id: bulkSendId, counts: { sent: counts.sent, queued: 0 } });
        expect(await runMail()).toHaveLength(counts.sent);
    }, 180_000);
});
