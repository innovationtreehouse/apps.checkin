// The scan-body generation this server speaks. 1 = bare participantId toggle;
// 2 = the replay/dead/intent/clockSuspect fields (KIOSK_RESILIENCE §2). The
// kiosk enables a generation's behavior only when /api/system-status/
// kiosk-version advertises it, so an auto-updating kiosk cannot race a
// not-yet-deployed server into misreading fields it does not know.
export const SCAN_PROTOCOL_VERSION = 2;
