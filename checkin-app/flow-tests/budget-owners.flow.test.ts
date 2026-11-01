/**
 * Budget-owner buckets and their approvers: FINANCE manages buckets,
 * the BOARD alone sets a bucket's owner and treasurers, nobody sets themself or
 * their own household, an org-level bucket takes no approvers, and archive keeps
 * the row. Real HTTP against the running dev server and the seeded DB.
 */
import { loginAs, api, type Session } from "./helpers";

const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const OUTSIDER = "parent.family2@example.com";
const OUTSIDER_HOUSEHOLD_PEER = "parent.family@example.com";

type Bucket = { id: number; name: string; isOrgLevel: boolean; archivedAt: string | null; quickBooksClassId: string | null };
type Approver = { budgetOwnerId: number; personId: number; name: string; role: "OWNER" | "TREASURER" };

const send = (s: Session, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

let finance: Session;
let board: Session;
let outsider: Session;
let bucketId: number;

beforeAll(async () => {
  [finance, board, outsider] = await Promise.all([loginAs(FINANCE), loginAs(BOARD), loginAs(OUTSIDER)]);
  const created = await send(finance, "POST", "/api/budget-owners", { name: `Flow approvers ${Date.now()}` });
  expect(created.status).toBe(200);
  bucketId = (created.json as Bucket).id;
});

const approvers = async (s: Session) => {
  const res = await api<Approver[]>(s, `/api/budget-owners/${bucketId}/approvers`);
  expect(res.status).toBe(200);
  return res.json;
};

describe("budget-owner buckets", () => {
  it("finance creates, renames and maps a bucket; the board reads it", async () => {
    const name = `Flow bucket ${Date.now()}`;
    const created = await send(finance, "POST", "/api/budget-owners", { name, isOrgLevel: true });
    expect(created.status).toBe(200);
    const bucket = created.json as Bucket;
    expect(bucket).toMatchObject({ name, isOrgLevel: true, archivedAt: null, quickBooksClassId: null });

    const classId = String(Date.now());
    const edited = await send(finance, "PATCH", `/api/budget-owners/${bucket.id}`, { name: `${name} (renamed)`, quickBooksClassId: classId });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ name: `${name} (renamed)`, quickBooksClassId: classId });

    const listed = await api<Bucket[]>(board, "/api/budget-owners");
    expect(listed.status).toBe(200);
    expect(listed.json.find((b) => b.id === bucket.id)).toMatchObject({ quickBooksClassId: classId });
  });

  it("refuses bucket writes to the board and to a plain member", async () => {
    for (const s of [board, outsider]) {
      expect((await send(s, "POST", "/api/budget-owners", { name: "Denied" })).status).toBe(403);
    }
    expect((await api(outsider, "/api/budget-owners")).status).toBe(403);
  });

  it("archive keeps the row: hidden by default, listed with includeArchived=1", async () => {
    const created = await send(finance, "POST", "/api/budget-owners", { name: `Flow archive ${Date.now()}` });
    expect(created.status).toBe(200);
    const id = (created.json as Bucket).id;

    const archived = await send(finance, "POST", `/api/budget-owners/${id}/archive`);
    expect(archived.status).toBe(200);
    expect((archived.json as Bucket).archivedAt).not.toBeNull();

    const active = await api<Bucket[]>(finance, "/api/budget-owners");
    expect(active.json.some((b) => b.id === id)).toBe(false);
    const all = await api<Bucket[]>(finance, "/api/budget-owners?includeArchived=1");
    expect(all.json.find((b) => b.id === id)?.archivedAt).not.toBeNull();
  });
});

describe("bucket approvers", () => {
  it("the board names an owner and adds and removes a treasurer; finance reads them", async () => {
    const owner = await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: outsider.personaId });
    expect(owner.status).toBe(200);
    expect(owner.json).toEqual([expect.objectContaining({ personId: outsider.personaId, role: "OWNER" })]);

    const peer = await loginAs(OUTSIDER_HOUSEHOLD_PEER);
    const added = await send(board, "PUT", `/api/budget-owners/${bucketId}/treasurers/${peer.personaId}`);
    expect(added.status).toBe(200);
    expect((await approvers(finance)).map((a) => [a.personId, a.role])).toEqual([
      [outsider.personaId, "OWNER"],
      [peer.personaId, "TREASURER"],
    ]);

    const removed = await send(board, "DELETE", `/api/budget-owners/${bucketId}/treasurers/${peer.personaId}`);
    expect(removed.status).toBe(200);
    const cleared = await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: null });
    expect(cleared.status).toBe(200);
    expect(await approvers(board)).toEqual([]);
  });

  it("the board cannot name themself or anyone in their own household", async () => {
    const self = await send(board, "PUT", `/api/budget-owners/${bucketId}/treasurers/${board.personaId}`);
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.json)).toMatch(/own household/);
    expect((await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: board.personaId })).status).toBe(403);

    const memberEmail = `board.household.${Date.now()}@example.com`;
    const adminAdd = await send(board, "POST", "/api/membership-ops/participants", {
      name: "Board Household Member",
      email: memberEmail,
      parentEmail: BOARD,
    });
    expect(adminAdd.status).toBe(403);

    const added = await send(board, "PATCH", "/api/household", {
      memberName: "Board Household Member",
      memberEmail,
      memberOver25: true,
    });
    expect(added.status).toBe(200);
    const memberId = (added.json as { member: { id: number } }).member.id;
    const peer = await send(board, "PUT", `/api/budget-owners/${bucketId}/treasurers/${memberId}`);
    expect(peer.status).toBe(403);
    expect(JSON.stringify(peer.json)).toMatch(/own household/);
    expect(await approvers(board)).toEqual([]);
  });

  it("an org-level bucket takes no approvers", async () => {
    const created = await send(finance, "POST", "/api/budget-owners", { name: `Flow org-level ${Date.now()}`, isOrgLevel: true });
    const id = (created.json as Bucket).id;
    expect((await send(board, "PUT", `/api/budget-owners/${id}/owner`, { personId: outsider.personaId })).status).toBe(409);
  });

  it("refuses an approver change from anyone not on the board", async () => {
    for (const s of [finance, outsider]) {
      expect((await send(s, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: outsider.personaId })).status).toBe(403);
      expect((await send(s, "PUT", `/api/budget-owners/${bucketId}/treasurers/${outsider.personaId}`)).status).toBe(403);
    }
    expect((await api(finance, "/api/budget-owners/approver-options")).status).toBe(403);
    expect((await api(outsider, `/api/budget-owners/${bucketId}/approvers`)).status).toBe(403);
  });
});
