// Integration suites that race transactions get a pool of 2 (jest.setup.js); on
// the default single connection their transactions take turns, so the test passes
// with the lock removed. A suite named *Concurrency.integration.test.ts is racing
// by name; the list holds racing suites named otherwise.
const RACING_SUITES = [
    'mintId',
    'facilityCloseLock',
    'cronNightlyLock',
    'scanFlushRace',
    'programRefundRace',
    'membershipRefundGate',
    'membershipPaymentPlanRace',
    'selfGrantRefusalAudit',
    'participants/merge/__tests__/route',
    'adminRolesAPI',
    'checkStarted',
    'closeAsEvent',
    'enrollmentStateOracle',
    'householdArchiveWrites',
    'householdQuestion',
    'householdsMembershipAuditAPI',
    'membershipContractSignAPI',
    'membershipPaymentAPI',
    'membershipReviewUndo',
    'programOrderSeatCap',
    'programPaymentPlansAPI',
    'programRefundGate',
    'specTrace',
    'outreach/__tests__/ledger',
    'finance/__tests__/financeViewLog',
    'finance/__tests__/reconcile',
    'receipt/__tests__/mailAliases',
    'lib/__tests__/opsIncidents',
    'lib/__tests__/postEventEmailClaim',
    'facilityCloseRecord',
    'householdsDenyAPI',
    'membershipBgNonBlocking',
]

const RACING_SUITE = new RegExp(`(Concurrency|${RACING_SUITES.join('|')})\\.integration\\.test\\.[jt]sx?$`)

module.exports = { RACING_SUITE }
