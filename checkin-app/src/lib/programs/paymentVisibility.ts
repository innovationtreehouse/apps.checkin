/**
 * Whether a non-staff viewer may see the payment status (paid / not paid yet) of
 * their own household's enrollments. Only a household lead who is not a known
 * youth; everyone else — a youth, a non-lead household member — sees none, and no
 * family ever sees another household's (docs/rules/programs.md, "Payment status").
 *
 * Client-safe: reads only session claims.
 */
export function seesHouseholdPaymentStatus(user: { householdLead?: boolean; ageBand?: string } | null | undefined): boolean {
    return !!user?.householdLead && user.ageBand !== 'youth';
}
