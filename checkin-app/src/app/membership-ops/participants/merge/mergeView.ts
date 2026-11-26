import { formatPhone } from "@/lib/phone";
import { formatDateOnly } from "@/lib/time";

export interface ParticipantMergeView {
  id: number;
  email?: string;
  name?: string;
  phone?: string;
  googleId?: string;
  emailVerified?: string | null;
  dateOfBirth?: string | null;
  _count: { visits: number, rawBadgeLogs: number, programParticipants: number, programVolunteers: number };
  household?: { id: number, name: string, _count?: { householdMembers: number }, householdMembers: Record<string, unknown>[] } | null;
  [key: string]: unknown;
}

export interface BgNotice {
  date: string;
}

export interface Collision {
  type: string;
  message: string;
  attestationIds?: number[];
}

// The membership block and background-check notice turn on which record is merged
// away, so each comes per direction (see lib/person/merge/guard.ts).
export interface MergeAnalysis {
  participants: [ParticipantMergeView, ParticipantMergeView];
  membershipBlock?: { aAsKeeper: string | null; bAsKeeper: string | null } | null;
  bgNotice?: { aAsKeeper: BgNotice | null; bAsKeeper: BgNotice | null } | null;
  collisions?: Collision[];
}

// Recommends keeping the record with more activity or better data.
export function activityScore(p: ParticipantMergeView): number {
  let s = 0;
  s += p._count.visits * 2;
  s += p._count.rawBadgeLogs;
  s += p._count.programParticipants * 5;
  s += p._count.programVolunteers * 5;
  if (p.email) s += 10;
  if (p.phone) s += 10;
  if (p.googleId) s += 20; // real account
  return s;
}

// Per-field conflict radios — mirrors the server's CONFLICT_FIELDS (route.ts).
// email/googleId/emailVerified are NOT here: they're the login identity, minted
// together at sign-in and resolved as ONE unit under the `identity` key (never
// split field-by-field). image/lastBackgroundCheck/lastWaiverSign auto-resolve.
export const CONFLICT_FIELDS = ["name", "phone", "dateOfBirth"] as const;
export type ConflictField = typeof CONFLICT_FIELDS[number];
export const FIELD_LABELS: Record<ConflictField, string> = {
  name: "Name", phone: "Phone", dateOfBirth: "Date of Birth",
};

// A login identity is present iff email OR googleId is set.
export function hasIdentity(p: { email?: string; googleId?: string }): boolean {
  return !!p.email || !!p.googleId;
}

// googleId has no human-readable value of its own — a raw "Connected" label reads
// identically for both sides of a conflict. Show the identity behind it instead: the
// person's own email (the account you'd recognize), falling back to the tail of
// the googleId itself when there's no email to show.
function googleIdIdentity(person: { email?: string; googleId?: string }): string {
  if (person.email) return person.email;
  if (person.googleId) return `…${person.googleId.slice(-6)}`;
  return "—";
}

// One option in the "which login identity survives?" radio: the side's email, the
// account behind its googleId, and whether that address is verified/controlled.
export function identityOptionLabel(p: { email?: string; googleId?: string; emailVerified?: string | null }): string {
  const parts = [p.email || "no email"];
  if (p.googleId) parts.push(`Google: ${googleIdIdentity(p)}`);
  parts.push(p.emailVerified ? "verified" : "unverified");
  return parts.join(" · ");
}

export function formatFieldValue(field: ConflictField, value: unknown): string {
  // dateOfBirth is the only date-kind field in CONFLICT_FIELDS, so the calendar-date
  // (UTC-pinned) read is right for every value that reaches this branch.
  if (field === "dateOfBirth" && typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : formatDateOnly(d);
  }
  if (field === "phone" && typeof value === "string") return formatPhone(value);
  return String(value ?? "—");
}
