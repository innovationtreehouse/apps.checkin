/**
 * Org inventory (#1287): the route + auth matrix (viewer vs INVENTORY_MANAGER
 * vs non-viewer) and one manager journey through every write. Real HTTP against
 * the running dev server and the seeded local-inventory DB (see
 * docker-compose.flow.yml + packages/local-inventory/prisma/seed.ts).
 */
import { loginAs, api, type Session } from "./helpers";

const VIEWER = "boardmember@example.com";
const MANAGER = "inventory.manager@example.com";
const NON_VIEWER = "parent.family@example.com";

const VIEWER_READS = [
  "/api/inventory/locations",
  "/api/inventory/org-items",
  "/api/inventory/org-items/count",
  "/api/inventory/receive-queue",
  "/api/inventory/inventory-log",
  "/api/inventory/inventory-log/count",
  "/api/inventory/received-inventory-deltas",
  "/api/inventory/received-inventory-deltas/count",
];
const MANAGER_READS = [
  "/api/inventory/inventory-merge-conflicts",
  "/api/inventory/provisional-items",
  "/api/inventory/received-org-events",
];
const WRITES: Array<[string, string, unknown?]> = [
  ["POST", "/api/inventory/locations", { name: "Denied" }],
  ["PUT", "/api/inventory/locations/1", { name: "Denied" }],
  ["DELETE", "/api/inventory/locations/1"],
  ["POST", "/api/inventory/locations/1/reassign", { targetLocationId: 2 }],
  ["POST", "/api/inventory/org-items", { gtin13: "0000000000017" }],
  ["PUT", "/api/inventory/org-items/0012345678905", { existingQuantity: 1 }],
  ["DELETE", "/api/inventory/org-items/0012345678905"],
  ["DELETE", "/api/inventory/receive-queue/1"],
  ["POST", "/api/inventory/receive-queue/1/fulfill"],
  ["PUT", "/api/inventory/inventory-merge-conflicts/1/resolve", { quantityMethod: "sum" }],
];

type LocationRow = { id: number; name: string; orgId?: string; _count?: { primaryItems: number; backstockItems: number } };
type OrgItemRow = {
  gtin13: string;
  existingQuantity: number;
  desiredQuantity: number;
  locationId: number | null;
  orgId?: string;
  location: { id: number; name: string } | null;
};
type QueueRow = { id: number; gtin13: string; quantity: number; fulfilledAt: string | null };
type ConflictRow = { id: number; status: string; realGtin13: string; provisionalGtin13: string; resolution?: string };
type LogRow = { gtin13: string; fieldChanged: string; valueAfter: string | null; username?: string | null };

const send = (s: Session, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("local inventory — route auth", () => {
  it("rejects every inventory route without a session", async () => {
    // CHECKIN_ENV=local resolves a cookieless request as the keyless kiosk, which
    // the viewer gate refuses with 403; elsewhere it is 401. Either way, rejected.
    for (const path of [...VIEWER_READS, ...MANAGER_READS]) {
      const { status } = await api(null, path);
      expect([path, [401, 403].includes(status)]).toEqual([path, true]);
    }
  });

  it("denies every inventory route to a signed-in non-viewer", async () => {
    const member = await loginAs(NON_VIEWER);
    for (const path of [...VIEWER_READS, ...MANAGER_READS]) {
      expect([path, (await api(member, path)).status]).toEqual([path, 403]);
    }
  });

  it("serves the viewer reads to a viewer and denies the manager work queues", async () => {
    const viewer = await loginAs(VIEWER);
    for (const path of VIEWER_READS) {
      expect([path, (await api(viewer, path)).status]).toEqual([path, 200]);
    }
    for (const path of MANAGER_READS) {
      expect([path, (await api(viewer, path)).status]).toEqual([path, 403]);
    }
  });

  it("denies every write to a viewer who is not a manager", async () => {
    const viewer = await loginAs(VIEWER);
    for (const [method, path, body] of WRITES) {
      expect([method, path, (await send(viewer, method, path, body)).status]).toEqual([method, path, 403]);
    }
  });

  it("serves a viewer public fields only, and a manager the internal ones too", async () => {
    const viewer = await loginAs(VIEWER);
    const manager = await loginAs(MANAGER);
    const asViewer = await api<OrgItemRow[]>(viewer, "/api/inventory/org-items");
    const asManager = await api<OrgItemRow[]>(manager, "/api/inventory/org-items");
    expect(asViewer.json.length).toBeGreaterThan(0);
    expect(asViewer.json[0].orgId).toBeUndefined();
    expect(asViewer.json[0].gtin13).toMatch(/^\d{13}$/);
    expect(asManager.json[0].orgId).toBe("treehouse");
  });

  it("server-renders an inventory page (proves the library tsx transpiles)", async () => {
    const viewer = await loginAs(VIEWER);
    expect((await api(viewer, "/inventory/org-items")).status).toBe(200);
  });
});

describe("local inventory — manager journey", () => {
  it("sets up stock, moves it, receives a backorder, and resolves a merge conflict", async () => {
    const m = await loginAs(MANAGER);
    const stamp = Date.now();

    // Locations: create two; the list reports their item counts.
    const bin = await send(m, "POST", "/api/inventory/locations", { name: `Bin ${stamp}` });
    const shelf = await send(m, "POST", "/api/inventory/locations", { name: `Shelf ${stamp}` });
    expect(bin.status).toBe(200);
    const binId = (bin.json as LocationRow).id;
    const shelfId = (shelf.json as LocationRow).id;
    expect((await send(m, "POST", "/api/inventory/locations", { name: "  " })).status).toBe(400);

    // Org item: create at the bin, then edit its quantities.
    const gtin = "0000000000017";
    expect((await send(m, "POST", "/api/inventory/org-items", { gtin13: "123" })).status).toBe(400);
    const created = await send(m, "POST", "/api/inventory/org-items", { gtin13: gtin, existingQuantity: 2, locationId: binId });
    expect(created.status).toBe(200);
    expect((created.json as OrgItemRow).location?.name).toBe(`Bin ${stamp}`);
    expect((await send(m, "POST", "/api/inventory/org-items", { gtin13: gtin })).status).toBe(409);

    const edited = await send(m, "PUT", `/api/inventory/org-items/${gtin}`, { existingQuantity: 5, desiredQuantity: 8 });
    expect(edited.json).toMatchObject({ existingQuantity: 5, desiredQuantity: 8, locationId: binId });

    const log = await api<LogRow[]>(m, "/api/inventory/inventory-log?limit=5");
    expect(log.json.some((e) => e.gtin13 === gtin && e.fieldChanged === "existingQuantity" && e.valueAfter === "5")).toBe(true);
    expect((await api<{ total: number }>(m, "/api/inventory/inventory-log/count")).json.total).toBeGreaterThan(0);

    // A location in use can't be deleted; reassigning its items frees it.
    expect((await send(m, "DELETE", `/api/inventory/locations/${binId}`)).status).toBe(409);
    expect((await send(m, "POST", `/api/inventory/locations/${binId}/reassign`, { targetLocationId: shelfId })).status).toBe(200);
    const moved = await api<OrgItemRow>(m, `/api/inventory/org-items/${gtin}`);
    expect(moved.json.location?.id).toBe(shelfId);
    expect((await send(m, "PUT", `/api/inventory/locations/${binId}`, { name: `Old bin ${stamp}` })).status).toBe(200);
    expect((await send(m, "DELETE", `/api/inventory/locations/${binId}`)).status).toBe(200);

    // Receive the seeded backorder line into stock; a second fulfill is a conflict.
    const queue = await api<QueueRow[]>(m, "/api/inventory/receive-queue");
    const line = queue.json.find((q) => q.gtin13 === "0098765432109")!;
    expect(line).toBeDefined();
    const fulfilled = await send(m, "POST", `/api/inventory/receive-queue/${line.id}/fulfill`);
    expect(fulfilled.status).toBe(200);
    expect((fulfilled.json as QueueRow).fulfilledAt).not.toBeNull();
    expect((await send(m, "POST", `/api/inventory/receive-queue/${line.id}/fulfill`)).status).toBe(409);
    expect((await api<OrgItemRow>(m, "/api/inventory/org-items/0098765432109")).json.existingQuantity).toBe(3);
    const open = await api<QueueRow[]>(m, "/api/inventory/receive-queue");
    expect(open.json.some((q) => q.id === line.id)).toBe(false);

    // Resolve the seeded uom_mismatch by summing both counts (4 provisional + 10 real).
    const conflicts = await api<ConflictRow[]>(m, "/api/inventory/inventory-merge-conflicts");
    const conflict = conflicts.json.find((c) => c.status === "pending")!;
    expect(conflict).toBeDefined();
    const resolved = await send(m, "PUT", `/api/inventory/inventory-merge-conflicts/${conflict.id}/resolve`, { quantityMethod: "sum" });
    expect(resolved.json).toMatchObject({ id: conflict.id, status: "resolved" });
    expect((await send(m, "PUT", `/api/inventory/inventory-merge-conflicts/${conflict.id}/resolve`, { quantityMethod: "sum" })).status).toBe(400);
    expect((await api<OrgItemRow>(m, `/api/inventory/org-items/${conflict.realGtin13}`)).json.existingQuantity).toBe(14);
    expect((await api(m, `/api/inventory/org-items/${conflict.provisionalGtin13}`)).status).toBe(404);

    // Stop tracking the item.
    expect((await send(m, "DELETE", `/api/inventory/org-items/${gtin}`)).status).toBe(200);
    expect((await api(m, `/api/inventory/org-items/${gtin}`)).status).toBe(404);
  });
});
