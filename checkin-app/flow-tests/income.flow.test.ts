/**
 * Income (#1283): the route + auth matrix (FINANCE vs BOARD vs a plain member vs
 * anonymous) and one finance journey through every write. Real HTTP against the
 * running dev server and the seeded income DB (docker-compose.flow.yml +
 * packages/income/prisma/seed.ts). The flow stack has no store mirror and no
 * QuickBooks, so matching itself is covered by the library's DB tier.
 */
import { loginAs, api, type Session } from "./helpers";

const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const MEMBER = "parent.family@example.com";

const SEED_PAYOUT = "gid://shopify/ShopifyPaymentsPayout/seed-1";

const READS = [
  "/api/income/payouts",
  "/api/income/reconciliation",
  "/api/income/reconciliation/count",
  "/api/income/items",
  "/api/income/qb-exclusions",
];
const FINANCE_READS = ["/api/income/reconciliation/1/candidates"];
const WRITES: Array<[string, string, unknown?]> = [
  ["POST", "/api/income/reconciliation/1/resolve", { action: "dismiss", reason: "denied" }],
  ["POST", "/api/income/reconciliation/run", {}],
  ["PUT", "/api/income/items/4242/category", { budgetOwnerId: 1 }],
  ["DELETE", "/api/income/items/4242/category"],
  ["POST", "/api/income/qb-exclusions", { qbTxnId: "denied", reason: "denied" }],
];

type ReconRow = { id: number; payoutGid: string; status: string; kind: string | null; reason?: string | null };
type ItemRow = { variantId: string; budgetOwnerId: number | null; budgetOwnerName: string | null };
type ExclusionRow = { id: number; qbTxnId: string; reason: string };

const send = (s: Session | null, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("income — route auth", () => {
  it("rejects every income route without a session", async () => {
    // CHECKIN_ENV=local resolves a cookieless request as the keyless kiosk, which
    // the finance gates refuse with 403; elsewhere it is 401. Either way, rejected.
    for (const path of [...READS, ...FINANCE_READS]) {
      const { status } = await api(null, path);
      expect([path, [401, 403].includes(status)]).toEqual([path, true]);
    }
    for (const [method, path, body] of WRITES) {
      const { status } = await send(null, method, path, body);
      expect([method, path, [401, 403].includes(status)]).toEqual([method, path, true]);
    }
  });

  it("denies every income route to a plain member", async () => {
    const member = await loginAs(MEMBER);
    for (const path of [...READS, ...FINANCE_READS]) {
      expect([path, (await api(member, path)).status]).toEqual([path, 403]);
    }
    for (const [method, path, body] of WRITES) {
      expect([method, path, (await send(member, method, path, body)).status]).toEqual([method, path, 403]);
    }
  });

  it("serves the board every read and denies it the candidates read and every write", async () => {
    const board = await loginAs(BOARD);
    for (const path of READS) {
      expect([path, (await api(board, path)).status]).toEqual([path, 200]);
    }
    for (const path of FINANCE_READS) {
      expect([path, (await api(board, path)).status]).toEqual([path, 403]);
    }
    for (const [method, path, body] of WRITES) {
      expect([method, path, (await send(board, method, path, body)).status]).toEqual([method, path, 403]);
    }
  });

  it("serves finance every read", async () => {
    const finance = await loginAs(FINANCE);
    for (const path of READS) {
      expect([path, (await api(finance, path)).status]).toEqual([path, 200]);
    }
  });

  it("server-renders an income page (proves the library tsx transpiles)", async () => {
    const finance = await loginAs(FINANCE);
    expect((await api(finance, "/income/reconciliation")).status).toBe(200);
  });
});

describe("income — finance journey", () => {
  it("runs reconciliation, maps an item, excludes a deposit and dismisses the seeded payout", async () => {
    const f = await loginAs(FINANCE);
    const stamp = Date.now();

    // With no mirror wired, a run is a no-op that answers zero counts, and no payouts show.
    const run = await send(f, "POST", "/api/income/reconciliation/run", {});
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ status: "unbound", matched: 0, opened: 0, drifted: 0 });
    expect((await api<unknown[]>(f, "/api/income/payouts")).json).toEqual([]);
    expect((await api(f, `/api/income/payouts/${encodeURIComponent(SEED_PAYOUT)}`)).status).toBe(404);

    // The seeded OPEN NO_DEPOSIT row is in the queue and the count.
    const queue = await api<ReconRow[]>(f, "/api/income/reconciliation");
    const seeded = queue.json.find((r) => r.payoutGid === SEED_PAYOUT)!;
    expect(seeded).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
    const before = (await api<{ total: number }>(f, "/api/income/reconciliation/count")).json.total;
    expect(before).toBeGreaterThan(0);

    // Candidates need QuickBooks, which the flow stack has not connected.
    expect((await api(f, `/api/income/reconciliation/${seeded.id}/candidates`)).status).toBe(503);

    // Item categories: an unknown bucket is refused; the seed's first bucket (Facility) maps.
    const variant = String(stamp);
    expect((await send(f, "PUT", `/api/income/items/${variant}/category`, { budgetOwnerId: 999999 })).status).toBe(422);
    expect((await send(f, "PUT", `/api/income/items/${variant}/category`, { budgetOwnerId: "1" })).status).toBe(400);
    expect((await send(f, "PUT", "/api/income/items/not-a-variant/category", { budgetOwnerId: 1 })).status).toBe(400);
    const mapped = await send(f, "PUT", `/api/income/items/${variant}/category`, { budgetOwnerId: 1 });
    expect(mapped.status).toBe(200);
    expect(mapped.json).toMatchObject({ variantId: variant, budgetOwnerId: 1 });
    const items = await api<ItemRow[]>(f, "/api/income/items");
    expect(items.json.find((i) => i.variantId === variant)).toMatchObject({ budgetOwnerId: 1, budgetOwnerName: "Facility" });
    expect((await send(f, "DELETE", `/api/income/items/${variant}/category`)).status).toBe(200);
    expect((await send(f, "DELETE", `/api/income/items/${variant}/category`)).status).toBe(404);

    // Exclusions are permanent: a reason is required and an id is excluded once.
    const qbTxnId = `flow-${stamp}`;
    expect((await send(f, "POST", "/api/income/qb-exclusions", { qbTxnId, reason: " " })).status).toBe(400);
    const excluded = await send(f, "POST", "/api/income/qb-exclusions", { qbTxnId, reason: "Check deposit" });
    expect(excluded.status).toBe(200);
    expect(excluded.json).toMatchObject({ qbTxnId, reason: "Check deposit" });
    expect((await send(f, "POST", "/api/income/qb-exclusions", { qbTxnId, reason: "again" })).status).toBe(409);
    const exclusions = await api<ExclusionRow[]>(f, "/api/income/qb-exclusions");
    expect(exclusions.json[0]).toMatchObject({ qbTxnId });

    // Resolve: dismiss needs a reason, then the row leaves the queue for good.
    expect((await send(f, "POST", `/api/income/reconciliation/${seeded.id}/resolve`, { action: "nope" })).status).toBe(400);
    expect((await send(f, "POST", `/api/income/reconciliation/${seeded.id}/resolve`, { action: "dismiss" })).status).toBe(400);
    expect((await send(f, "POST", `/api/income/reconciliation/${seeded.id}/resolve`, { action: "retry" })).status).toBe(409);
    const dismissed = await send(f, "POST", `/api/income/reconciliation/${seeded.id}/resolve`, { action: "dismiss", reason: "Booked by hand in 2026" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.json).toMatchObject({ id: seeded.id, status: "RESOLVED", reason: "Booked by hand in 2026" });
    expect((await send(f, "POST", `/api/income/reconciliation/${seeded.id}/resolve`, { action: "dismiss", reason: "again" })).status).toBe(409);
    expect((await api<ReconRow[]>(f, "/api/income/reconciliation")).json.some((r) => r.id === seeded.id)).toBe(false);
    expect((await api<{ total: number }>(f, "/api/income/reconciliation/count")).json.total).toBe(before - 1);

    // A missing row is a 404, not another org's data.
    expect((await send(f, "POST", "/api/income/reconciliation/999999/resolve", { action: "dismiss", reason: "x" })).status).toBe(404);
  });
});
