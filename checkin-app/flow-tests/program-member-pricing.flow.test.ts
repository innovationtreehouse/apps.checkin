/**
 * @jest-environment node
 */
/**
 * Flow test for the single-pool member-pricing journey: board creates a priced
 * program, the non-member probes the discount-code route, the member self-enrolls
 * and gets a household-bound code (and is refused for a mixed-household cart), and
 * paying (via the dev Shopify orders/paid stand-in) activates their enrollment.
 * Exercises program creation → enroll → discount-code → pay as a whole HTTP
 * journey, wired through real auth, routes, and DB.
 *
 * Personas: boardmember@example.com (board, creates the program),
 * member.pricing@example.com (fee-settled household lead — ACTIVE OrgMembership
 * from the seed), and certified.adult@example.com (solo household, no
 * OrgMembership row — a genuine non-member, used read-only here).
 */
import { loginAs, api } from "./helpers";

type ProgramCreate = { success: boolean; program: { id: number; shopifyVariantId: string | null } };
type DiscountCode = { code: string | null; reason?: string };
type Enrollment = { success: boolean; enrollment: { status: string } };
type OrdersPaid = { ok: boolean; participants: { personId: number; status: string }[] };

describe("flow: program purchase with member pricing", () => {
    it("board creates a priced program; member gets a discount code and settles by payment; non-member gets no code", async () => {
        const board = await loginAs("boardmember@example.com");
        const member = await loginAs("member.pricing@example.com");
        const nonMember = await loginAs("certified.adult@example.com");
        const lead = await loginAs("inventory.manager@example.com");

        const memberId = member.personaId;

        const tag = Date.now().toString(36);
        const created = await api<ProgramCreate>(board, "/api/programs", {
            method: "POST",
            body: JSON.stringify({
                name: `Member Pricing Program ${tag}`,
                leadMentorId: lead.personaId,
                startAt: "2026-01-01",
                endAt: "2026-12-31",
                memberPrice: "40",
                nonMemberPrice: "50",
                maxParticipants: 10,
            }),
        });
        expect(created.status).toBe(200);
        expect(created.json.success).toBe(true);
        const programId = created.json.program.id;
        // Single-pool model: one Shopify variant at the base price, minted by the
        // local dev mock (CHECKIN_ENV=local) since the program is priced.
        expect(created.json.program.shopifyVariantId).not.toBeNull();

        // POST /api/programs creates every program CLOSED (schema default) — open
        // enrollment before anyone can join.
        const opened = await api(board, `/api/programs/${programId}`, {
            method: "PATCH",
            body: JSON.stringify({ enrollmentStatus: "OPEN", offSaleAt: "2999-01-01" }),
        });
        expect(opened.status).toBe(200);

        const nonMemberDiscount = await api<DiscountCode>(nonMember, `/api/programs/${programId}/discount-code`, {
            method: "POST",
            body: JSON.stringify({ participantIds: [nonMember.personaId] }),
        });
        expect(nonMemberDiscount.status).toBe(200);
        expect(nonMemberDiscount.json.code).toBeNull();

        const enroll = await api<Enrollment>(member, `/api/programs/${programId}/participants`, {
            method: "POST",
            body: JSON.stringify({ participantId: memberId }),
        });
        expect(enroll.status).toBe(200);
        expect(enroll.json.enrollment.status).toBe("PENDING");

        // One order pays for one household.
        const mixed = await api<DiscountCode>(member, `/api/programs/${programId}/discount-code`, {
            method: "POST",
            body: JSON.stringify({ participantIds: [memberId, nonMember.personaId] }),
        });
        expect(mixed.status).toBe(400);

        const memberDiscount = await api<DiscountCode>(member, `/api/programs/${programId}/discount-code`, {
            method: "POST",
            body: JSON.stringify({ participantIds: [memberId] }),
        });
        expect(memberDiscount.status).toBe(200);
        expect(memberDiscount.json.code).toEqual(expect.stringMatching(new RegExp(`^PRG${programId}-H\\d+-`)));
        expect(memberDiscount.json.reason).toBeUndefined();

        const paid = await api<OrdersPaid>(member, "/api/dev/shopify/orders-paid", {
            method: "POST",
            body: JSON.stringify({ programId, participantIds: [memberId] }),
        });
        expect(paid.status).toBe(200);
        expect(paid.json.ok).toBe(true);
        const activatedMember = paid.json.participants.find((p) => p.personId === memberId);
        expect(activatedMember?.status).toBe("ACTIVE");
    });
});
