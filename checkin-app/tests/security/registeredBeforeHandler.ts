/** Registered verbs whose route file still serves them outside handler(); the integration sweeps do not drive them. */
export const REGISTERED_BEFORE_HANDLER: ReadonlySet<string> = new Set([
    'PATCH /api/roles',
]);
