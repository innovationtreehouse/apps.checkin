/** Programs, their sessions and their places, set up over HTTP as the Board and the family would. */
import { api, loginAs } from "../../flow-tests/helpers";
import { addYouth, settledFamily } from "./families";
import { BOARD, send } from "./seedState";

const MINUTE = 60_000;

/** A date `days` from today, as the program forms take it. */
export const inDays = (days: number) => new Date(Date.now() + days * 1440 * MINUTE).toISOString().slice(0, 10);

/** Dates two to four weeks out stay inside one membership year, so the Board states none. */
export const PROGRAM_DATES = { startAt: inDays(14), endAt: inDays(28) };

export interface Named { id: number; name: string }

/** A new adult in a household of their own who has declared themself over 25, old enough to lead a program; returns their email. */
export async function newLeader(): Promise<string> {
  const email = await settledFamily();
  const leader = await loginAs(email);
  const declared = await send(leader, "PATCH", "/api/household/member", { participantId: leader.personaId, over25: true });
  if (declared.status !== 200) throw new Error(`declare leader over 25: ${declared.status}`);
  return email;
}

/** A priced program the Board created with a new leader, open for enrollment. */
export async function newProgram(capacity = 2): Promise<Named & { leader: string }> {
  const board = await loginAs(BOARD);
  const name = `Browser Program ${Date.now()}`;
  const leader = await newLeader();
  const created = await send(board, "POST", "/api/programs", {
    name,
    leadMentorId: (await loginAs(leader)).personaId,
    ...PROGRAM_DATES,
    memberPrice: "40",
    nonMemberPrice: "50",
    maxParticipants: capacity,
  });
  if (created.status !== 200) throw new Error(`create program: ${created.status}`);
  const { id } = (created.json as { program: { id: number } }).program;
  const opened = await send(board, "PATCH", `/api/programs/${id}`, { enrollmentStatus: "OPEN", phase: "UPCOMING" });
  if (opened.status !== 200) throw new Error(`open program: ${opened.status}`);
  return { id, name, leader };
}

/** A session of the program running from `startMinutes` to `endMinutes` from now; negative is in the past. */
export async function newSession(programId: number, startMinutes: number, endMinutes: number): Promise<Named> {
  const board = await loginAs(BOARD);
  const name = `Browser Session ${Date.now()}`;
  // The create form takes wall-clock times on one day, so the session is made ahead and then moved.
  const created = await send(board, "POST", "/api/events", { name, programId, startDate: inDays(2), startTime: "10:00", endTime: "11:00" });
  if (created.status !== 200) throw new Error(`create session: ${created.status}`);
  const { json } = await api<{ events: Named[] }>(board, `/api/programs/${programId}`);
  const session = json.events.find((e) => e.name === name);
  if (!session) throw new Error(`session ${name} not on program ${programId}`);
  const moved = await send(board, "PATCH", `/api/events/${session.id}`, {
    action: "editTime",
    startAt: new Date(Date.now() + startMinutes * MINUTE).toISOString(),
    endAt: new Date(Date.now() + endMinutes * MINUTE).toISOString(),
  });
  if (moved.status !== 200) throw new Error(`move session: ${moved.status}`);
  return session;
}

/** The family's lead claims a place for each youth, leaving them waiting on payment. */
export async function claim(email: string, programId: number, youthIds: number[]): Promise<void> {
  const lead = await loginAs(email);
  for (const participantId of youthIds) {
    const claimed = await send(lead, "POST", `/api/programs/${programId}/participants`, { participantId });
    if (claimed.status !== 200) throw new Error(`claim place: ${claimed.status}`);
  }
}

/** Pays the family's claims through the dev Shopify mock. */
export async function pay(email: string, programId: number, youthIds: number[]): Promise<void> {
  const paid = await send(await loginAs(email), "POST", "/api/dev/shopify/orders-paid", { programId, participantIds: youthIds });
  if (paid.status !== 200) throw new Error(`pay places: ${paid.status}`);
}

/** A new family whose youth holds a paid place in the program. */
export async function paidYouth(programId: number): Promise<{ email: string; youth: Named }> {
  const email = await settledFamily();
  const youth = await addYouth(email);
  await claim(email, programId, [youth.id]);
  await pay(email, programId, [youth.id]);
  return { email, youth };
}
