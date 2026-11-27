/**
 * @jest-environment node
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { listCurrentMembers } from "@/lib/membership/currentMembers";
import { GET } from "../route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/prisma", () => {
    const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    return { __esModule: true, default: { $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)), tx } };
});
jest.mock("@/lib/db-client", () => ({ isRootClient: () => false }));
jest.mock("@/lib/membership/currentMembers", () => ({
    ...jest.requireActual("@/lib/membership/currentMembers"),
    listCurrentMembers: jest.fn(),
}));

const call = () => GET(new Request("http://localhost/api/membership-ops/members/export") as never, { params: Promise.resolve({}) });
const signIn = (flags: object) =>
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 5, ...flags }, expires: "2099-01-01" } as never);

beforeEach(() => jest.clearAllMocks());

it("403s a non-Board caller without reading members or auditing", async () => {
    signIn({ isSysadmin: true });
    expect((await call()).status).toBe(403);
    expect(listCurrentMembers).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("serves the CSV to the Board and writes one audit row with who and the count", async () => {
    signIn({ isBoardMember: true });
    jest.mocked(listCurrentMembers).mockResolvedValue([{ email: "a@x.org", name: "Ann", validThrough: null }]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.csv).toContain('"a@x.org","Ann",""');
    const create = (prisma as unknown as { tx: { auditLog: { create: jest.Mock } } }).tx.auditLog.create;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({ actorId: 5, tableName: "MEMBERS_EXPORT", newData: { count: 1 } });
});
