import type { Prisma } from '@/generated/prisma/client';

/**
 * Visit with included participant and event data, as returned by getFullAttendance.
 * PII-minimized (M1): email/googleId and role flags are deliberately NOT part of this
 * shape — getFullAttendance resolves the display name server-side and strips them, so a
 * consumer typed against this can't reach back for the raw address/identifiers.
 */
export type VisitWithDetails = Prisma.VisitGetPayload<{
    include: {
        participant: {
            select: {
                id: true;
                name: true;
                isKeyholder: true;
                dateOfBirth: true;
                householdId: true;
                phone: true;
                household: {
                    select: {
                        id: true;
                        emergencyContacts: {
                            select: {
                                id: true;
                                name: true;
                                phone: true;
                                relationship: true;
                            };
                        };
                    };
                };
            };
        };
        event: {
            include: {
                program: true;
            };
        };
    };
}>;

/**
 * Attendance counts breakdown.
 */
export interface AttendanceCounts {
    keyholders: number;
    volunteers: number;
    youth: number;
    total: number;
}

/**
 * Safety flags for the facility.
 */
export interface SafetyFlags {
    /** A keyholder is present. The only test for "open" — never `counts.total`. */
    facilityOpen: boolean;
    isLastKeyholder: boolean;
    isTwoDeepViolation: boolean;
}

/**
 * Full attendance response from getFullAttendance().
 */
export interface AttendanceData {
    attendance: VisitWithDetails[];
    counts: AttendanceCounts;
    safety: SafetyFlags;
}
