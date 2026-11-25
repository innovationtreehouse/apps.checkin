import { CLOSABLE_STATUSES, awaitingBgReview, refundableApplication, type ProcessKind, type ProcessStatus } from "@/lib/membership/lifecycle";

export interface Person {
  id: number;
  name: string | null;
  email: string | null;
  isHouseholdLead: boolean;
}
export interface Attestation {
  id: number;
  result: string;
  subjectPersonId: number | null;
  isMarkedVolunteerFamily: boolean;
}
export interface ProcessRow {
  id: number;
  kind: string;
  status: string;
  createdAt: string;
  zohoEnvelopeId: string | null;
  contractSignedAt: string | null;
  bgConsentAt: string | null;
  bgClearedAt: string | null;
  paidAt: string | null;
  attestations: Attestation[];
  requestedForHouseholdId: number | null;
  subjectPerson: { id: number; name: string | null; householdId: number | null } | null;
  orgMembership: {
    householdId: number;
    isVolunteerFamily: boolean;
    household: { name: string | null; householdMembers: Person[] } | null;
  } | null;
  // A renewal for the year its household has said it won't renew into.
  notRenewing: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  INTAKE: "gray",
  PENDING_EXTERNAL_ACTION: "blue",
  PENDING_BG_REVIEW: "grape",
  PENDING_PAYMENT: "orange",
  PENDING_BG_CLEARANCE: "grape",
  BLOCKED: "red",
  PENDING_RENEWAL: "teal",
  RENEWAL_PENDING_BG: "grape",
};

const KIND_LABELS: Record<string, string> = {
  INITIAL: "New membership",
  RENEWAL: "Renewal",
  PERSON_AGREEMENT: "Membership agreement",
  PERSON_BG: "Background check",
  KEY_VOLUNTEER_AGREEMENT: "Key Volunteer agreement",
};

export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

export const statusColor = (status: string) => STATUS_COLORS[status] || "gray";
// The "Not renewing" tag filters through the status filter's param, under a value no status takes.
export const NOT_RENEWING = "not-renewing";
export const statusLabel = (status: string) =>
  status === NOT_RENEWING ? "Not renewing" : status === "ARCHIVED" ? "CLOSED" : status.replace(/_/g, " ");

// A check review in the reviewer queue. ONE definition, shared with the server:
// awaitingBgReview.has — client-safe (booleans in, no Prisma).
export const awaitingBg = (r: ProcessRow) =>
  awaitingBgReview.has({ kind: r.kind as ProcessKind, status: r.status as ProcessStatus, bgConsentAt: !!r.bgConsentAt, bgClearedAt: !!r.bgClearedAt });

export const leadsOf = (r: ProcessRow) => (r.orgMembership?.household?.householdMembers ?? []).filter((p) => p.isHouseholdLead);

// A household's check is started when an open review has a lead's check started, or a
// review it asked for waits to be named, or the application carries the legacy flag.
// Mirrors householdCheckStarted on the server, from rows this page already has.
export const householdCheckStarted = (r: ProcessRow, rows: readonly ProcessRow[]) => {
  const householdId = r.orgMembership?.householdId;
  if (householdId === undefined) return false;
  if (r.bgConsentAt) return true;
  const leadIds = new Set(leadsOf(r).map((p) => p.id));
  return rows.some((p) =>
    p.kind === "PERSON_BG" && (p.status === "PENDING_BG_REVIEW" || p.status === "BLOCKED") &&
    ((!!p.bgConsentAt && !!p.subjectPerson && leadIds.has(p.subjectPerson.id)) || (!p.subjectPerson && p.requestedForHouseholdId === householdId)));
};

// A household application with its check started and not cleared waits on its people's check reviews.
export const waitingOnCheckReview = (r: ProcessRow, rows: readonly ProcessRow[]) =>
  r.kind !== "PERSON_BG" && !!r.orgMembership && !r.bgClearedAt && r.status !== "BLOCKED" && householdCheckStarted(r, rows);

// Mirror archiveApplication's and recordRefund's gates; the server re-checks.
export const closable = (r: ProcessRow) => !r.paidAt && (CLOSABLE_STATUSES as readonly string[]).includes(r.status);
export const refundable = (r: ProcessRow) => refundableApplication.has({ status: r.status, paidAt: !!r.paidAt });

// An awaiting review only ever holds APPROVE attestations (any REJECT blocks it).
export const approvals = (r: ProcessRow) => r.attestations.filter((a) => a.result === "APPROVE").length;

// A blocked household application with nobody in its household under a blocked check
// review: whoever's rejection blocked it has left. The server re-checks.
export const releasable = (r: ProcessRow, rows: readonly ProcessRow[]) =>
  r.kind !== "PERSON_BG" && r.status === "BLOCKED" && !!r.orgMembership &&
  !rows.some((p) => p.kind === "PERSON_BG" && p.status === "BLOCKED" && p.subjectPerson?.householdId === r.orgMembership?.householdId);

// A per-person process has no household; it is named for its subject person.
export const processLabel = (r: ProcessRow) => {
  if (!r.orgMembership && r.subjectPerson) return r.subjectPerson.name || `Person #${r.subjectPerson.id}`;
  const hh = r.orgMembership?.household;
  if (!hh) return `Household #${r.orgMembership?.householdId ?? "?"}`;
  const parents = (hh.householdMembers || []).filter((p) => p.isHouseholdLead).map((p) => p.name || p.email).filter(Boolean);
  return hh.name || parents.join(" & ") || `Household #${r.orgMembership?.householdId}`;
};
