/**
 * Global catalog journey (#1286 track 5): view the catalog as a viewer, curate
 * it as an INVENTORY_MANAGER, and confirm the read/write gates (§6). Real HTTP
 * against the running dev server, seeded catalog DB (see docker-compose.flow.yml
 * + packages/global-catalog/prisma/seed.ts). No app imports, no DB access.
 */
import { loginAs, api } from "./helpers";

type ItemRow = {
  gtin13: string;
  name: string;
  category: { name: string; letter: string };
  subcategory: { name: string; number: number };
};
type CategoryRow = { id: number; name: string; letter: string; archivedAt: string | null };

describe("global catalog", () => {
  it("serves the seeded catalog to a viewer with nested category relations", async () => {
    // boardmember is a catalog viewer (any RBAC role admits reads, §6).
    const viewer = await loginAs("boardmember@example.com");
    const { status, json } = await api<ItemRow[]>(viewer, "/api/catalog/items");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    const roborio = json.find((i) => i.name === "Roborio v2");
    expect(roborio).toBeDefined();
    // Model-bag shape (track 4): nested relations, not flattened strings.
    expect(roborio!.category.name).toBe("Electronics");
    expect(roborio!.subcategory.number).toBe(10);
  });

  it("serves an item count for pagination and pages the list", async () => {
    // The list can't carry a total (the stripper drops non-model scalars, §7),
    // so the count rides the synthetic CatalogItemCount model at a dedicated
    // endpoint. Two items seeded → total 2; limit=1 pages one row at a time.
    const viewer = await loginAs("boardmember@example.com");
    const count = await api<{ total: number }>(viewer, "/api/catalog/items/count");
    expect(count.status).toBe(200);
    expect(count.json.total).toBe(2);

    const p1 = await api<ItemRow[]>(viewer, "/api/catalog/items?limit=1&page=1&sortBy=name&sortDir=asc");
    const p2 = await api<ItemRow[]>(viewer, "/api/catalog/items?limit=1&page=2&sortBy=name&sortDir=asc");
    expect(p1.json.length).toBe(1);
    expect(p2.json.length).toBe(1);
    expect(p2.json[0].gtin13).not.toBe(p1.json[0].gtin13); // page 2 ≠ page 1
  });

  it("denies the item count to a non-viewer", async () => {
    const member = await loginAs("parent.family@example.com");
    const { status } = await api(member, "/api/catalog/items/count");
    expect(status).toBe(403);
  });

  it("server-renders the Items page (proves the library tsx transpiles via transpilePackages)", async () => {
    // The API routes never touch the library's .tsx; only rendering a catalog
    // page does. An authenticated GET reaches the page render (middleware admits
    // the session), so a missing transpilePackages entry would 500 here.
    const viewer = await loginAs("boardmember@example.com");
    const { status } = await api(viewer, "/catalog/items");
    expect(status).toBe(200);
  });

  it("denies catalog reads to a plain household member (not a viewer)", async () => {
    // parent.family has no RBAC role, leads no program, holds no volunteer
    // designation — the three session-visible viewer legs all fail, and the seed
    // adds no VolunteerDesignation, so the DB leg fails too.
    const member = await loginAs("parent.family@example.com");
    const { status } = await api(member, "/api/catalog/items");
    expect(status).toBe(403);
  });

  it("lets an INVENTORY_MANAGER create a category, and reflects it on read", async () => {
    const manager = await loginAs("inventory.manager@example.com");
    const letter = "Q";
    const name = `FlowTest Cat ${Date.now()}`;

    const created = await api<CategoryRow>(manager, "/api/catalog/categories", {
      method: "POST",
      body: JSON.stringify({ name, letter }),
    });
    expect(created.status).toBe(200);
    expect(created.json.name).toBe(name);
    expect(created.json.letter).toBe(letter);

    const list = await api<CategoryRow[]>(manager, "/api/catalog/categories");
    expect(list.status).toBe(200);
    expect(list.json.some((c) => c.id === created.json.id)).toBe(true);
  });

  it("denies catalog writes to a viewer who is not a manager", async () => {
    const viewer = await loginAs("boardmember@example.com");
    const { status } = await api(viewer, "/api/catalog/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Should Not Persist", letter: "Z" }),
    });
    expect(status).toBe(403);
  });

  it("serves the (empty) proposal queue to a viewer", async () => {
    // No proposals exist without the receipt/S4 producer (deferred), but the
    // read path + its viewer gate must work — the Proposals screen relies on it.
    const viewer = await loginAs("boardmember@example.com");
    const { status, json } = await api<unknown[]>(viewer, "/api/catalog/proposals/item-references");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it("returns 404 for an unknown item and 409 on a duplicate category letter (error states)", async () => {
    const manager = await loginAs("inventory.manager@example.com");

    const missing = await api(manager, "/api/catalog/items/9999999999999");
    expect(missing.status).toBe(404);

    // Letter N is taken by the seeded Electronics category (unique among active).
    const dup = await api(manager, "/api/catalog/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Duplicate Letter", letter: "N" }),
    });
    expect(dup.status).toBe(409);
  });
});
