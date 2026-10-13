// Stable org ids the DB-backed service tests stamp rows with. The source's user/token
// seeding helpers were auth-coupled (@inventory/auth, retired per design §6) and are not
// ported — Track 1 covers services against real SQL, not route auth.
export const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const TEST_ORG_ID_2 = "00000000-0000-0000-0000-000000000002";
