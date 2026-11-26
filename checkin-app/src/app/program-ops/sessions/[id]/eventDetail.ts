import type { RSVPStatus } from '@/types/rsvp';

export type ParticipantDetail = {
  personId: number;
  person: {
    id: number;
    name: string | null;
    email: string;
  };
  isCore?: boolean;
};

export type EventData = {
  id: number;
  name: string;
  startAt: string;
  endAt: string;
  attendanceConfirmedAt: string | null;
  attendanceConfirmedBy?: { name: string | null } | null;
  recurringGroupId: string | null;
  program?: {
    id: number;
    name: string;
    leadMentorId: number | null;
    volunteers: ParticipantDetail[];
    participants: ParticipantDetail[];
  };
  visits: {
    id: number;
    personId: number;
    arrivedAt: string;
    departedAt: string | null;
  }[];
  rsvps: { personId: number; status: RSVPStatus }[];
};

export type RosterMember = ParticipantDetail & { role: string };

export type Visit = EventData['visits'][number];
