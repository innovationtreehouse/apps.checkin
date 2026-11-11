/**
 * The board's background-check recheck window (`BoardSettings.bgRecheckMonths`).
 * 0 — the column default — and a missing settings row both mean the board has not
 * set it. While it is unset every background check counts as already expired, in
 * every reader: renewal, intake, supervision (docs/rules/membership.md, Renewal;
 * docs/rules/attendance-checkin.md, Supervision).
 */
export function isRecheckPolicySet(recheckMonths: number | null | undefined): recheckMonths is number {
    return recheckMonths != null && recheckMonths > 0;
}
