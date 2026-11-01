/**
 * @jest-environment node
 */
/**
 * Flow test: a test order refunded with restock before its orders/paid webhook
 * leaves the store at capacity. Store stock is read through the over-capacity
 * shortfall: a final restocking refund after the sale has ended takes 3 seats off
 * a program of capacity 2, so the shortfall left in the carry shows what was on sale.
 */
import crypto from "crypto";
import { loginAs, api, BASE, type Session } from "./helpers";

type ProgramCreate = { program: { id: number; shopifyVariantId: string } };
type ProgramEdit = { program: { shopifyStockCarry: number } };

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "dev-shopify-mock-webhook-secret";

async function webhook(path: string, topic: string, payload: object): Promise<void> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-shopify-topic": topic,
            "x-shopify-hmac-sha256": crypto.createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64"),
        },
        body,
    });
    expect(res.status).toBe(200);
}

function refund(refundId: string, orderId: string, variantId: string, quantity: number): Promise<void> {
    return webhook("/api/webhooks/shopify/reversals", "refunds/create", {
        id: refundId,
        order_id: orderId,
        refund_line_items: [{ quantity, restock_type: "return", line_item: { variant_id: variantId, quantity } }],
    });
}

async function carryOf(board: Session, programId: number): Promise<number> {
    // Only the edit route returns the whole row, so an empty edit reads the carry.
    const res = await api<ProgramEdit>(board, `/api/programs/${programId}`, { method: "PATCH", body: "{}" });
    expect(res.status).toBe(200);
    return res.json.program.shopifyStockCarry;
}

/** Stock pushes run after the webhook answers, so wait for the carry to reach `expected`. */
async function carrySettlesAt(board: Session, programId: number, expected: number): Promise<number> {
    let carry = await carryOf(board, programId);
    for (let i = 0; i < 40 && carry !== expected; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        carry = await carryOf(board, programId);
    }
    return carry;
}

describe("flow: test order refunded before its paid webhook", () => {
    it("adds no store seat", async () => {
        const board = await loginAs("boardmember@example.com");
        const lead = await loginAs("inventory.manager@example.com");
        const tag = Date.now().toString(36);

        const created = await api<ProgramCreate>(board, "/api/programs", {
            method: "POST",
            body: JSON.stringify({
                name: `Test Order Refund ${tag}`,
                leadMentorId: lead.personaId,
                startAt: "2026-01-01",
                endAt: "2026-12-31",
                appliesToYear: 2025,
                memberPrice: "40",
                nonMemberPrice: "50",
                maxParticipants: 2,
            }),
        });
        expect(created.status).toBe(200);
        const { id: programId, shopifyVariantId: variantId } = created.json.program;

        const open = await api(board, `/api/programs/${programId}`, { method: "PATCH", body: JSON.stringify({ offSaleAt: "2999-01-01" }) });
        expect(open.status).toBe(200);

        const testOrder = `test-order-${tag}`;
        await refund(`refund-${tag}`, testOrder, variantId, 1);
        await webhook("/api/webhooks/shopify", "orders/paid", {
            id: testOrder,
            test: true,
            financial_status: "paid",
            line_items: [{ variant_id: variantId, quantity: 1 }],
        });
        expect(await carrySettlesAt(board, programId, 0)).toBe(0);

        const ended = await api(board, `/api/programs/${programId}`, { method: "PATCH", body: JSON.stringify({ offSaleAt: "2020-01-01" }) });
        expect(ended.status).toBe(200);
        await refund(`probe-${tag}`, `stranger-order-${tag}`, variantId, 3);

        // Capacity 2 on sale leaves a shortfall of 1; a third seat on sale would leave none.
        expect(await carrySettlesAt(board, programId, -1)).toBe(-1);
    }, 180_000);
});
