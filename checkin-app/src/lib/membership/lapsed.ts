import { orgCalendarDay } from "@/lib/time";

/**
 * Has an ACTIVE household's coverage lapsed? True when its valid-through day is
 * already behind today's org calendar day. Status is untouched: revoking is the
 * board's call, so a lapsed household still reads as a member.
 */
export function isMembershipLapsed(validThrough?: string | Date | null): boolean {
    return !!validThrough && new Date(validThrough).getTime() < orgCalendarDay().getTime();
}
