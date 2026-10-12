/**
 * Bulk donation (#1280): the persona matrix (FINANCE, BOARD, a plain member,
 * anonymous) over every /api/donations route, UploadedFile.fileBlob absent from
 * every JSON response, the stored-CSV download, and one finance journey
 * (upload → assign with a comment rule → hold → account rule → resubmit →
 * booking batch → duplicate re-upload). Real HTTP against the running dev
 * server and the seeded bulk-donation DB (see docker-compose.flow.yml +
 * packages/bulk-donation/prisma/seed.ts).
 */
import { BASE, loginAs, api, type Session } from "./helpers";

const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const MEMBER = "parent.family@example.com";

const READS = [
  "/api/donations/uploaded-files",
  "/api/donations/transactions",
  "/api/donations/transactions?assigned=true",
  "/api/donations/transactions/unassigned",
  "/api/donations/comment-rules",
  "/api/donations/account-map",
  "/api/donations/disbursement-holds",
  "/api/donations/disbursement-events",
  "/api/donations/nav-counts",
  "/api/donations/disbursement-events/SEED-D1/qb-candidates",
  "/api/donations/qb-exclusions",
];
const WRITES: Array<[string, string, unknown?]> = [
  ["POST", "/api/donations/uploaded-files"],
  ["DELETE", "/api/donations/uploaded-files/1/blob"],
  ["PATCH", "/api/donations/transactions/1/owner", { ownerId: 1 }],
  ["PATCH", "/api/donations/transactions/1/organizational-level"],
  ["DELETE", "/api/donations/comment-rules/1"],
  ["POST", "/api/donations/account-map", { companyName: "Denied" }],
  ["PUT", "/api/donations/account-map/1", { companyName: "Denied" }],
  ["DELETE", "/api/donations/account-map/1"],
  ["POST", "/api/donations/disbursement-holds/SEED-D2/resubmit"],
  ["POST", "/api/donations/disbursement-events/SEED-D1/qb-resolve", { action: "retry" }],
  ["POST", "/api/donations/qb-exclusions", { qbTxnId: "denied", reason: "denied" }],
];
// Id-bearing reads, filled in from the seeded rows.
const idReads = (txId: number, fileId: number) => [
  `/api/donations/transactions/${txId}`,
  `/api/donations/uploaded-files/${fileId}/blob`,
];

type FileRow = { id: number; originalFilename: string; allDuplicate: boolean; blobDeleted: boolean };
type GiftRow = {
  id: number;
  transactionId: string;
  donorFirstName?: string | null;
  donorComment?: string | null;
  ownerId: number | null;
  isOrganizationalLevel: boolean;
};
type HoldRow = { disbursementId: string; reason: string; transaction: { companyName: string | null } | null };
type EventRow = { disbursementId: string; qbMatchState: string };
type Owner = { id: number; name: string };

const send = (s: Session, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const HEADER =
  "Company Name,Corporate / Peer Campaign,Disbursement ID,Disbursement Date,Transaction ID,Donation Date,Donation Amount,Match Amount,Merchant Fee,Donor First Name,Donor Last Name,Donor Comment";

/** POST a Benevity CSV as multipart, the way the upload screen does. */
async function upload(s: Session, name: string, lines: string[]) {
  const form = new FormData();
  form.append("file", new File([[HEADER, ...lines].join("\n")], name, { type: "text/csv" }));
  const encoded = new Request("http://local/", { method: "POST", body: form });
  return api<FileRow & { newRowCount: number; duplicateRowCount: number }>(s, "/api/donations/uploaded-files", {
    method: "POST",
    headers: { "content-type": encoded.headers.get("content-type") ?? "" },
    body: await encoded.arrayBuffer(),
  });
}

async function seededIds(s: Session): Promise<{ txId: number; fileId: number }> {
  const gifts = await api<GiftRow[]>(s, "/api/donations/transactions");
  const files = await api<FileRow[]>(s, "/api/donations/uploaded-files");
  const seedFile = files.json.find((f) => f.originalFilename === "seed-benevity.csv");
  if (!seedFile || gifts.json.length === 0) throw new Error("bulk-donation seed missing");
  return { txId: gifts.json[0].id, fileId: seedFile.id };
}

describe("bulk donation — route auth", () => {
  it("rejects every donation route without a session", async () => {
    // CHECKIN_ENV=local resolves a cookieless request as the keyless kiosk (403); elsewhere 401.
    for (const path of [...READS, ...idReads(1, 1)]) {
      const { status } = await api(null, path);
      expect([path, [401, 403].includes(status)]).toEqual([path, true]);
    }
    for (const [method, path, body] of WRITES) {
      const { status } = await api(null, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect([method, path, [401, 403].includes(status)]).toEqual([method, path, true]);
    }
  });

  it("denies every donation route to a plain member", async () => {
    const member = await loginAs(MEMBER);
    for (const path of [...READS, ...idReads(1, 1)]) {
      expect([path, (await api(member, path)).status]).toEqual([path, 403]);
    }
    for (const [method, path, body] of WRITES) {
      expect([method, path, (await send(member, method, path, body)).status]).toEqual([method, path, 403]);
    }
  });

  it("serves every read to FINANCE and BOARD, including donor names", async () => {
    const finance = await loginAs(FINANCE);
    const { txId, fileId } = await seededIds(finance);
    for (const email of [FINANCE, BOARD]) {
      const s = await loginAs(email);
      for (const path of [...READS, ...idReads(txId, fileId)]) {
        expect([email, path, (await api(s, path)).status]).toEqual([email, path, 200]);
      }
      const gift = await api<GiftRow>(s, `/api/donations/transactions/${txId}`);
      expect(typeof gift.json.donorFirstName).toBe("string");
    }
  });

  it("denies every write to BOARD", async () => {
    const board = await loginAs(BOARD);
    for (const [method, path, body] of WRITES) {
      expect([method, path, (await send(board, method, path, body)).status]).toEqual([method, path, 403]);
    }
  });

  it("never returns fileBlob from a JSON route", async () => {
    const finance = await loginAs(FINANCE);
    const { txId } = await seededIds(finance);
    for (const path of [...READS, `/api/donations/transactions/${txId}`]) {
      const { status, json } = await api(finance, path);
      expect(status).toBe(200);
      expect([path, JSON.stringify(json).includes("fileBlob")]).toEqual([path, false]);
    }
  });

  it("downloads the stored CSV as a text/plain attachment for finance", async () => {
    const finance = await loginAs(FINANCE);
    const { fileId } = await seededIds(finance);
    const cookie = [...finance.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}/api/donations/uploaded-files/${fileId}/blob`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="seed-benevity.csv"');
    expect(await res.text()).toContain("seed-tx-1");
  });

  it("serves the seeded held disbursement with its transaction relation", async () => {
    const finance = await loginAs(FINANCE);
    const holds = await api<HoldRow[]>(finance, "/api/donations/disbursement-holds");
    const seeded = holds.json.find((h) => h.disbursementId === "SEED-D2");
    expect(seeded?.transaction?.companyName).toBe("Globex");
  });

  it("server-renders a donations page (proves the library tsx transpiles)", async () => {
    const finance = await loginAs(FINANCE);
    expect((await api(finance, "/donations/unassigned")).status).toBe(200);
  });
});

describe("bulk donation — finance journey", () => {
  it("imports a file, assigns an owner, clears a hold, and ignores a duplicate upload", async () => {
    const f = await loginAs(FINANCE);
    const stamp = Date.now();
    const company = `Flow Co ${stamp}`;
    const disbursement = `FLOW-${stamp}`;
    const comment = `robotics ${stamp}`;
    const firstFile = [
      `${company},Spring,${disbursement},2026-09-10,${stamp}-1,2026-09-01,40.00,40.00,1.00,Org,Level,`,
      `${company},Spring,${disbursement},2026-09-10,${stamp}-2,2026-09-02,60.00,0,1.50,Rosa,Parks,${comment}`,
    ];

    // Upload: the comment-less gift is organizational-level; the other waits for an owner.
    const first = await upload(f, `flow-${stamp}.csv`, firstFile);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ newRowCount: 2, duplicateRowCount: 0, allDuplicate: false });
    expect(typeof first.json.id).toBe("number");
    const queue = await api<GiftRow[]>(f, "/api/donations/transactions/unassigned");
    const waiting = queue.json.find((g) => g.transactionId === `${stamp}-2`);
    expect(waiting?.donorComment).toBe(comment);
    expect(queue.json.some((g) => g.transactionId === `${stamp}-1`)).toBe(false);

    // Assign an owner and make the comment a rule; an unknown owner is refused.
    const owners = await api<Owner[]>(f, "/api/budget-owners");
    const facility = owners.json.find((o) => o.name === "Facility");
    if (!waiting || !facility) throw new Error("journey setup missing");
    expect((await send(f, "PATCH", `/api/donations/transactions/${waiting.id}/owner`, { ownerId: 999999 })).status).toBe(400);
    const assigned = await send(f, "PATCH", `/api/donations/transactions/${waiting.id}/owner`, {
      ownerId: facility.id,
      assignFutureMatchingComment: true,
    });
    expect(assigned.status).toBe(200);
    expect((assigned.json as GiftRow).ownerId).toBe(facility.id);
    for (const key of ["donorFirstName", "donorLastName", "donorComment"]) expect(assigned.json).not.toHaveProperty(key);
    const rules = await api<Array<{ comment: string }>>(f, "/api/donations/comment-rules");
    expect(rules.json.some((r) => r.comment === comment)).toBe(true);

    // Every gift has an owner, but no account rule matches the company: the disbursement holds.
    const held = await api<HoldRow[]>(f, "/api/donations/disbursement-holds");
    const ours = held.json.filter((h) => h.disbursementId === disbursement);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours[0].transaction?.companyName).toBe(company);
    const counts = await api<{ unassignedQueue: number; disbursementHolds: number }>(f, "/api/donations/nav-counts");
    expect(counts.json.disbursementHolds).toBeGreaterThan(0);

    // Add the rule, resubmit: the hold clears and a booking batch appears.
    const rule = await send(f, "POST", "/api/donations/account-map", {
      companyName: company,
      corporatePeerCampaign: "*",
      donationAccount: "Contributions:Corporate Giving",
      matchAccount: "Contributions:Corporate Match",
      feesAccount: "Fees:Benevity",
    });
    expect(rule.status).toBe(200);
    expect((await send(f, "POST", `/api/donations/disbursement-holds/${disbursement}/resubmit`)).status).toBe(200);
    const after = await api<HoldRow[]>(f, "/api/donations/disbursement-holds");
    expect(after.json.some((h) => h.disbursementId === disbursement)).toBe(false);
    const events = await api<EventRow[]>(f, "/api/donations/disbursement-events");
    expect(events.json.find((e) => e.disbursementId === disbursement)?.qbMatchState).toBe("UNMATCHED");
    expect((await send(f, "POST", `/api/donations/disbursement-holds/${disbursement}/resubmit`)).status).toBe(409);

    // A later gift with the same comment takes the rule's owner at upload.
    expect((await upload(f, `flow-${stamp}-b.csv`, [
      `${company},Spring,${disbursement}-B,2026-09-11,${stamp}-3,2026-09-03,10.00,0,0.25,Ruth,Ginsburg,${comment}`,
    ])).status).toBe(200);
    const assignedGifts = await api<GiftRow[]>(f, "/api/donations/transactions?assigned=true");
    expect(assignedGifts.json.find((g) => g.transactionId === `${stamp}-3`)?.ownerId).toBe(facility.id);

    // Re-uploading the first file adds nothing; its stored copy can then be dropped.
    const again = await upload(f, `flow-${stamp}-again.csv`, firstFile);
    expect(again.json).toMatchObject({ newRowCount: 0, duplicateRowCount: 2, allDuplicate: true });
    expect((await send(f, "DELETE", `/api/donations/uploaded-files/${first.json.id}/blob`)).status).toBe(400);
    const dropped = await send(f, "DELETE", `/api/donations/uploaded-files/${again.json.id}/blob`);
    expect(dropped.json).toMatchObject({ id: again.json.id, blobDeleted: true });
    expect((await api(f, `/api/donations/uploaded-files/${again.json.id}/blob`)).status).toBe(404);

    // The QuickBooks queue: exclusions persist once; resolving waits for the drain.
    const exclusion = { qbTxnId: `qb-${stamp}`, reason: "hand-booked twice" };
    expect((await send(f, "POST", "/api/donations/qb-exclusions", exclusion)).status).toBe(200);
    expect((await send(f, "POST", "/api/donations/qb-exclusions", exclusion)).status).toBe(409);
    expect((await api<unknown[]>(f, `/api/donations/disbursement-events/${disbursement}/qb-candidates`)).json).toEqual([]);
    expect((await send(f, "POST", `/api/donations/disbursement-events/${disbursement}/qb-resolve`, { action: "retry" })).status).toBe(503);
  });
});
