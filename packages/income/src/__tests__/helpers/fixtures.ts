import { db } from "../../db";

export const ORG_A = "00000000-0000-0000-0000-00000000000a";
export const ORG_B = "00000000-0000-0000-0000-00000000000b";

let _nextUserId = 500;
export function newUserId() { return _nextUserId++; }

export async function clearAll() {
  await db.payoutReconciliation.deleteMany();
  await db.incomeAuditLog.deleteMany();
  await db.incomeItemCategory.deleteMany();
}
