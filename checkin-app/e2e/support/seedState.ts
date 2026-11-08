/**
 * Seed-state changes the browser specs need, each returning its undo. A fresh seed releases no
 * library and has no budget bucket with an owner.
 */
import { expect } from "@playwright/test";
import { LIBRARY_KEYS, type LibraryKey } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { api, loginAs, type Session } from "../../flow-tests/helpers";

export const FINANCE = "finance@example.com";
export const BOARD = "boardmember@example.com";
export const APPROVER = "keyholder1@example.com";
export const TREASURER = "keyholder2@example.com";
export const INVENTORY_MANAGER = "inventory.manager@example.com";
export const MEMBER = "parent.family@example.com";

export type Undo = () => Promise<void>;

export const send = (s: Session, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const release = (board: Session, library: LibraryKey, released: boolean) =>
  send(board, "PUT", "/api/settings/membership", { perYearVariantClient: true, releaseLibrary: { library, released } });

/** Releases every library, which unhides library pages for everyone but the Board. */
export async function releaseLibraries(): Promise<Undo> {
  const board = await loginAs(BOARD);
  const before = (await api<TodoCounts>(board, "/api/nav/todo-counts")).json.releasedLibraries ?? [];
  for (const library of LIBRARY_KEYS) expect([library, (await release(board, library, true)).status]).toEqual([library, 200]);
  return async () => {
    for (const library of LIBRARY_KEYS.filter((l) => !before.includes(l))) await release(board, library, false);
  };
}

/** A new budget bucket owned by `ownerEmail`, with `treasurerEmail` as its treasurer when given. */
export async function bucket(name: string, ownerEmail: string, treasurerEmail?: string): Promise<{ id: number; name: string; undo: Undo }> {
  const board = await loginAs(BOARD);
  const created = await send(await loginAs(FINANCE), "POST", "/api/budget-owners", { name });
  expect(created.status).toBe(200);
  const id = (created.json as { id: number }).id;
  const owner = await loginAs(ownerEmail);
  expect((await send(board, "PUT", `/api/budget-owners/${id}/owner`, { personId: owner.personaId })).status).toBe(200);
  const treasurer = treasurerEmail ? await loginAs(treasurerEmail) : null;
  if (treasurer) expect((await send(board, "PUT", `/api/budget-owners/${id}/treasurers/${treasurer.personaId}`)).status).toBe(200);
  return {
    id,
    name,
    undo: async () => {
      if (treasurer) await send(board, "DELETE", `/api/budget-owners/${id}/treasurers/${treasurer.personaId}`);
      await send(board, "PUT", `/api/budget-owners/${id}/owner`, { personId: null });
    },
  };
}
