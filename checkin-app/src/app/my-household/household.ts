import type { StructuredAddress } from '@/lib/address';
import type { BgStatus } from '@/lib/membership/bgStatus';
import { isValidPhone, PHONE_ERROR } from '@/lib/phone';
import { isValidEmail } from '@/lib/emergencyContacts/identity';
import { calculateAge } from '@/lib/time';

export type HouseholdMember = { id: number; name?: string; nickname?: string | null; email?: string; dateOfBirth?: string; phone?: string; isDeclaredAdult?: boolean; allergies?: string | null; isHouseholdLead?: boolean; emailLocked?: boolean; bgStatus?: { personId: number; status?: BgStatus } };
export type EmergencyContact = { id: number; name: string; phone: string; email?: string | null; relationship?: string | null; priority: number; invalid: boolean };
export type OrgMembership = { status?: string; memberSince?: string; isVolunteerFamily?: boolean; notRenewingYear?: number | null };
export type HouseholdData = {
  id?: number;
  name?: string;
  householdMembers?: HouseholdMember[];
  orgMembership?: OrgMembership | null;
} & Partial<StructuredAddress> | null;
export type HouseholdAnswer = { household: HouseholdData; boardReplyTo?: string | null; validUntil?: string | null };

export type ContactWarning = { message: string } | null | undefined;
export type MemberAnswer = { message?: string; warning?: { message: string } | null; leadRejection?: string } | null;

export type MemberFieldErrors = { name?: string; email?: string; dob?: string; phone?: string };

export const EMAIL_ERROR = "Enter a valid email address.";
const DOB_ERROR = "Date of birth is required for anyone under 25.";

// Shared client validation for the member add/edit forms. Returns red-ring +
// subtext errors keyed by field; empty object means valid.
export function validateHouseholdMemberFields(f: { name: string; email: string; dob: string; over25: boolean; phone?: string }) {
  const e: MemberFieldErrors = {};
  if (!f.name.trim()) e.name = "Name is required.";
  if (f.email && !isValidEmail(f.email)) e.email = EMAIL_ERROR;
  if (!f.over25 && !f.dob) e.dob = DOB_ERROR;
  if (f.phone && !isValidPhone(f.phone)) e.phone = PHONE_ERROR;
  return e;
}

// Upper-right age chip for a member card. A DoB drives an exact age; absent a
// DoB we trust the 25+ declaration, else the age is unknown and flagged red.
export function ageBadge(p: HouseholdMember): { label: string; color: string; variant: string } {
  if (p.dateOfBirth) {
    const age = calculateAge(p.dateOfBirth);
    return age < 18 ? { label: `Age (${age})`, color: 'blue', variant: 'light' } : { label: 'Adult', color: 'gray', variant: 'light' };
  }
  if (p.isDeclaredAdult) return { label: 'Adult', color: 'gray', variant: 'light' };
  return { label: 'Age Unavailable', color: 'red', variant: 'filled' };
}

// The background-check status the route sends only to the person and their household lead.
export const BG_STATUS_BADGE: Record<BgStatus, { label: string; color: string }> = {
  VALID: { label: 'Background check: Valid', color: 'green' },
  EXPIRES_BEFORE_NEXT_YEAR: { label: 'Background check: Expires before upcoming year', color: 'yellow' },
  EXPIRED: { label: 'Background check: Expired', color: 'red' },
};
