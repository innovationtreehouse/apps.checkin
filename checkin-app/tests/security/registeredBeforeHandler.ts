/** Registered verbs whose route file still serves them outside handler(); the integration sweeps do not drive them. */
export const REGISTERED_BEFORE_HANDLER: ReadonlySet<string> = new Set([
    'GET /api/facility/trends',
    'GET /api/safety/emergency-contacts',
    'GET /api/membership-audit/households-missing-contact',
    'GET /api/membership-audit/unclaimed-households',
    'GET /api/membership/payment',
    'GET /api/membership/renewal-status',
]);
