/**
 * Budget-owner buckets and program treasurers (#1280 §6): FINANCE manages
 * buckets, the BOARD alone sets treasurers, nobody sets themself or their own
 * household, and archive keeps the row. Real HTTP against the running dev server
 * and the seeded DB.
 */
import { loginAs, api, type Session } from "./helpers";

const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const OUTSIDER = "parent.family2@example.com";
const OUTSIDER_HOUSEHOLD_PEER = "parent.family@example.com";

type Bucket = { id: number; name: string; programId: number | null; archivedAt: string | null; quickBooksClassId: string | null };
type ProgramOption = { id: number; name: string };
type TreasurerRow = { personId: number; isTreasurer: boolean; person: { id: number; name: string } };

const send = (s: Session, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

let finance: Session;
let board: Session;
let outsider: Session;
let programId: number;

beforeAll(async () => {
  [finance, board, outsider] = await Promise.all([loginAs(FINANCE), loginAs(BOARD), loginAs(OUTSIDER)]);
  const programs = await api<ProgramOption[]>(board, "/api/budget-owners/program-options");
  expect(programs.status).toBe(200);
  const woodworking = programs.json.find((p) => p.name === "Woodworking 101");
  if (!woodworking) throw new Error("seeded program Woodworking 101 not found");
  programId = woodworking.id;
});

const volunteer = async (personId: number) => {
  const res = await send(board, "POST", `/api/programs/${programId}/volunteers`, { participantId: personId });
  expect([200, 409]).toContain(res.status);
};

const treasurers = async (s: Session) => {
  const res = await api<TreasurerRow[]>(s, `/api/programs/${programId}/treasurers`);
  expect(res.status).toBe(200);
  return res.json;
};

describe("budget-owner buckets", () => {
  it("finance creates, renames and maps a bucket; the board reads it", async () => {
    const name = `Flow bucket ${Date.now()}`;
    const created = await send(finance, "POST", "/api/budget-owners", { name, programId });
    expect(created.status).toBe(200);
    const bucket = created.json as Bucket;
    expect(bucket).toMatchObject({ name, programId, archivedAt: null, quickBooksClassId: null });

    const classId = `flow-class-${Date.now()}`;
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

describe("program treasurers", () => {
  it("the board sets and clears a treasurer", async () => {
    await volunteer(outsider.personaId);

    const set = await send(board, "PUT", `/api/programs/${programId}/treasurers/${outsider.personaId}`);
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ personId: outsider.personaId, isTreasurer: true });
    expect((await treasurers(finance)).find((r) => r.personId === outsider.personaId)?.isTreasurer).toBe(true);

    const cleared = await send(board, "DELETE", `/api/programs/${programId}/treasurers/${outsider.personaId}`);
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ isTreasurer: false });
  });

  it("the board cannot set themself or anyone in their own household", async () => {
    await volunteer(board.personaId);
    const self = await send(board, "PUT", `/api/programs/${programId}/treasurers/${board.personaId}`);
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.json)).toMatch(/own household/);

    const added = await send(board, "POST", "/api/membership-ops/participants", {
      name: "Board Household Member",
      email: `board.household.${Date.now()}@example.com`,
      parentEmail: BOARD,
    });
    expect(added.status).toBe(200);
    const memberId = (added.json as { participant: { id: number } }).participant.id;
    await volunteer(memberId);

    const peer = await send(board, "PUT", `/api/programs/${programId}/treasurers/${memberId}`);
    expect(peer.status).toBe(403);
    expect(JSON.stringify(peer.json)).toMatch(/own household/);

    const rows = await treasurers(board);
    expect(rows.filter((r) => r.personId === board.personaId || r.personId === memberId).every((r) => !r.isTreasurer)).toBe(true);
  });

  it("refuses a treasurer change from anyone not on the board", async () => {
    const peer = await loginAs(OUTSIDER_HOUSEHOLD_PEER);
    await volunteer(peer.personaId);
    for (const s of [finance, outsider]) {
      expect((await send(s, "PUT", `/api/programs/${programId}/treasurers/${peer.personaId}`)).status).toBe(403);
      expect((await send(s, "DELETE", `/api/programs/${programId}/treasurers/${peer.personaId}`)).status).toBe(403);
    }
    expect((await api(outsider, `/api/programs/${programId}/treasurers`)).status).toBe(403);
  });
});
