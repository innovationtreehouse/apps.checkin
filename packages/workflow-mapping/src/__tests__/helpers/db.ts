import { backendPid, describeDb as gate, waitersBehind } from "@checkin/pg-test-harness";
import { db } from "../../db";

export const describeDb = gate("WORKFLOW_MAPPING_DATABASE_URL");

/**
 * Runs `action` while another transaction blocks inserts into the audit log, calls `observe` once
 * `action` waits on its audit write, then lets it finish.
 */
export async function atAuditWrite<T>(action: () => Promise<T>, observe: () => Promise<void>): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held!: (pid: number) => void;
  const isHeld = new Promise<number>((r) => (held = r));
  const holder = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`LOCK TABLE workflow_audit_log IN EXCLUSIVE MODE`;
      held(await backendPid(tx));
      await released;
    },
    { timeout: 20_000 },
  );
  const holderPid = await isHeld;
  const result = action();
  try {
    await waitersBehind(db, holderPid);
    await observe();
  } finally {
    release();
    await holder;
  }
  return result;
}
