import { api, loginAs } from "../../flow-tests/helpers";
import { BOARD } from "./seedState";

/** Mints a one-person household with no membership and returns its lead's email. */
export async function newFamily(): Promise<string> {
  const minted = await api<{ personaId: number }>(null, "/api/auth/dev-personas", { method: "POST" });
  if (minted.status !== 200) throw new Error(`mint family: ${minted.status}`);
  const { personaId } = minted.json;
  // The mint answers with the id only; a bare number searches the directory by id.
  const { json } = await api<{ people: Array<{ id: number; email: string }> }>(await loginAs(BOARD), `/api/people/search?q=${personaId}`);
  const person = json.people.find((p) => p.id === personaId);
  if (!person) throw new Error(`minted family ${personaId} not in the directory`);
  return person.email;
}
