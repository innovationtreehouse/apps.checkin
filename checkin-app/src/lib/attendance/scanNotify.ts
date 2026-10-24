import { sendCheckinNotifications } from "@/lib/notifications";
import type { ScanOutcome } from "@/lib/attendance/scan";

/**
 * Send the check-in/out email for a committed scan. Runs only after the scan
 * transaction commits, so a rollback can't leave a false email and a retried
 * (duplicate_ignored) scan can't send a second one. `at` is the scan's event
 * time, so a replayed or held scan reports when it happened.
 */
export async function notifyScanOutcome(outcome: Extract<ScanOutcome, { kind: "checkin" | "checkout" }>, at: Date): Promise<void> {
    const personId = outcome.person.id;
    if (outcome.kind === "checkin") {
        if (outcome.departedAtClose) return;
        sendCheckinNotifications(personId, "checkin", "SCANNER", at).catch(err =>
            console.error("Checkin notification error:", err)
        );
        return;
    }
    // A close request for a keyholder already checked out departs nobody: the keyholder
    // already left, and got their checkout email then.
    if (outcome.visit === null) return;
    sendCheckinNotifications(personId, "checkout", undefined, at).catch(err =>
        console.error("Checkout notification error:", err)
    );
}
