/**
 * A gift of goods takes its capital decision on its own lines: a gift over the org's capital
 * thresholds waits on capital review once accepted, finance designates its lines and sets the
 * capital line's period on the gift, and the in-kind drain registers one asset per unit before the
 * gift waits on nothing but booking. A gift under both thresholds skips review. Real HTTP against
 * the running dev server.
 */
import { api, loginAs, newClassId, type Session } from "./helpers";

const RECORDER = "inventory.manager@example.com";
const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";

type Line = { id: number; quantity: number; isCapital: boolean | null; depreciationYears: number | null; capitalBucketId: number | null; registeredAt: string | null };
/** An event's payload is its JSON text. */
type GiftEvent = { eventType: string; payload: string | null };
type Gift = {
  outcome: string | null;
  capitalReviewNeeded: boolean | null;
  waitingOn: string[];
  revenueBooking: string | null;
  expenseBooking: string | null;
  lines: Line[];
  events: GiftEvent[];
};
type Thresholds = { capitalTotalThresholdCents: number | null; capitalLineItemThresholdCents: number | null };
type SeedResult = { created: number; skipped: number; errors: number };

// The first test to touch each route waits on the dev server compiling it.
jest.setTimeout(120_000);

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = new Date().toISOString().slice(0, 10);

const post = <T = unknown>(s: Session, path: string, body: unknown = {}) => api<T>(s, path, { method: "POST", body: JSON.stringify(body) });
const put = <T = unknown>(s: Session, path: string, body: unknown) => api<T>(s, path, { method: "PUT", body: JSON.stringify(body) });

let recorder: Session;
let finance: Session;
let board: Session;
let gtin13: string;
let bucket: number;
let priorThresholds: Thresholds | undefined;

const giftPath = (id: number) => `/api/donations/in-kind/manual/${id}`;

async function readGift(id: number): Promise<Gift> {
  const res = await api<Gift>(finance, giftPath(id));
  expect(res.status).toBe(200);
  return res.json;
}

/** Records a gift without a receipt as the recorder, then accepts it as finance at the given line values. */
async function acceptGift(label: string, lines: Array<{ quantity: number; valueCents: number }>): Promise<number> {
  const recorded = await post<{ id: number }>(recorder, "/api/donations/in-kind/manual", {
    donor: { firstName: "Flow", lastName: `Donor ${stamp}`, companyName: null },
    donationDate: today,
    lines: lines.map((l, i) => ({ gtin13, quantity: l.quantity, description: `${label} ${i + 1} ${stamp}` })),
  });
  expect(recorded.status).toBe(200);
  const id = recorded.json.id;

  const gift = await readGift(id);
  const decided = await post(finance, `${giftPath(id)}/decision`, {
    outcome: "accept",
    bucketId: bucket,
    confirmOutsideDonorHousehold: true,
    confirmGoodsReceived: true,
    lineValues: gift.lines.map((l, i) => ({ lineId: l.id, valueCents: lines[i].valueCents })),
  });
  expect(decided.status).toBe(200);
  return id;
}

/** Asks for an in-kind posting run and waits for `done` to hold of the gift, for up to 60 seconds. */
async function drainUntil(id: number, done: (g: Gift) => boolean): Promise<Gift> {
  const run = await post(finance, "/api/finance/quickbooks/catch-up", { lane: "in-kind" });
  expect(run.status).toBe(200);
  const until = Date.now() + 60_000;
  for (;;) {
    const gift = await readGift(id);
    if (done(gift)) return gift;
    if (Date.now() > until) throw new Error(`gift ${id} still waiting on ${gift.waitingOn.join(", ")} after 60 s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  [recorder, finance, board] = await Promise.all([loginAs(RECORDER), loginAs(FINANCE), loginAs(BOARD)]);

  const items = await api<Array<{ gtin13: string }>>(recorder, "/api/catalog/items?limit=1");
  expect(items.status).toBe(200);
  gtin13 = items.json[0].gtin13;

  const created = await post<{ id: number }>(finance, "/api/budget-owners", { name: `Gift capital ${stamp}`, quickBooksClassId: newClassId() });
  expect(created.status).toBe(200);
  bucket = created.json.id;

  const current = await api<Thresholds>(board, "/api/expense/org-settings");
  expect(current.status).toBe(200);
  // Setting a threshold from unset loosens it, which is the Board's.
  expect((await put(board, "/api/expense/org-settings", { capitalTotalThresholdCents: 2500, capitalLineItemThresholdCents: 1250 })).status).toBe(200);
  priorThresholds = { capitalTotalThresholdCents: current.json.capitalTotalThresholdCents, capitalLineItemThresholdCents: current.json.capitalLineItemThresholdCents };
});

afterAll(async () => {
  // A threshold cannot go back to unset; 0 holds every record at capital review, as unset does.
  if (priorThresholds) {
    expect((await put(board, "/api/expense/org-settings", {
      capitalTotalThresholdCents: priorThresholds.capitalTotalThresholdCents ?? 0,
      capitalLineItemThresholdCents: priorThresholds.capitalLineItemThresholdCents ?? 0,
    })).status).toBe(200);
  }
});

describe("gift capital review", () => {
  it("reviews a gift over the thresholds on its own lines and registers one asset per unit before it books", async () => {
    // Two units at $1,500 each, and a $10 line that is decided with the rest.
    const id = await acceptGift("Donated lathe", [{ quantity: 2, valueCents: 300_000 }, { quantity: 1, valueCents: 1_000 }]);

    const accepted = await readGift(id);
    expect(accepted.outcome).toBe("ACCEPTED");
    expect(accepted.capitalReviewNeeded).toBe(true);
    expect(accepted.waitingOn).toContain("capital");
    const [lathe, small] = accepted.lines;
    expect(lathe.isCapital).toBeNull();
    expect(small.isCapital).toBeNull();

    const designated = await post(finance, `${giftPath(id)}/capital-review`, {
      lineItems: [
        { lineItemId: lathe.id, isCapital: true, capitalOwnerId: bucket },
        { lineItemId: small.id, isCapital: false },
      ],
    });
    expect(designated.status).toBe(200);
    const afterDesignation = await readGift(id);
    expect(afterDesignation.lines.map((l) => l.isCapital)).toEqual([true, false]);
    expect(afterDesignation.waitingOn).toContain("capital");

    // No route lists the register, so the mint is read through the seed route: a number it already
    // holds is refused. Seeding above every number issued fixes what the mint takes next.
    const base = Math.floor(Date.now() / 1000) + 100;
    const seed = (n: number) => post<SeedResult>(finance, "/api/expense/capital-assets/seed", [{ assetNumber: `ITFA${n}`, description: `Probe ${stamp}` }]);
    expect((await seed(base)).json).toMatchObject({ created: 1 });

    const period = await post(finance, `${giftPath(id)}/set-depreciation-cycle`, { items: [{ lineItemId: lathe.id, depreciationYears: 5, ownerId: bucket }] });
    expect(period.status).toBe(200);

    // The period is set but nothing is registered yet: the gift waits on registration, not booking alone.
    const unregistered = await readGift(id);
    expect(unregistered.lines[0]).toMatchObject({ isCapital: true, depreciationYears: 5, capitalBucketId: bucket, registeredAt: null });
    expect(unregistered.waitingOn).toEqual(expect.arrayContaining(["register", "booking"]));
    expect(unregistered.waitingOn).not.toContain("capital");
    expect(unregistered.revenueBooking).toBeNull();
    expect(unregistered.expenseBooking).toBeNull();
    // The next number is still free, so the period step minted nothing; the drain mints the two after it.
    expect((await seed(base + 1)).json).toMatchObject({ created: 1 });

    const registered = await drainUntil(id, (g) => g.lines[0].registeredAt !== null);
    expect(registered.waitingOn).not.toContain("register");
    expect(registered.lines[1].registeredAt).toBeNull();

    const stamped = registered.events.filter((e) => e.eventType === "IN_KIND_CAPITAL_REGISTERED");
    expect(stamped).toHaveLength(1);
    expect(JSON.parse(stamped[0].payload ?? "null")).toEqual({ lineId: lathe.id, assetNumbers: [`ITFA${base + 2}`, `ITFA${base + 3}`] });
    expect((await seed(base + 2)).json).toMatchObject({ created: 0, skipped: 0, errors: 1 });
    expect((await seed(base + 3)).json).toMatchObject({ created: 0, skipped: 0, errors: 1 });

    // The step is taken once.
    expect((await post(finance, `${giftPath(id)}/set-depreciation-cycle`, { items: [{ lineItemId: lathe.id, depreciationYears: 5, ownerId: bucket }] })).status).toBe(409);
  });

  it("skips capital review for a gift under both thresholds", async () => {
    const id = await acceptGift("Donated clamp", [{ quantity: 1, valueCents: 1_000 }]);

    const gift = await readGift(id);
    expect(gift.capitalReviewNeeded).toBe(false);
    expect(gift.waitingOn).not.toContain("capital");
    expect(gift.waitingOn).not.toContain("register");
    expect(gift.lines[0].isCapital).toBeNull();
    expect((await post(finance, `${giftPath(id)}/capital-review`, { lineItems: [{ lineItemId: gift.lines[0].id, isCapital: true, capitalOwnerId: bucket }] })).status).toBe(409);
  });
});
