// The scan-body generation this server speaks. 1 = bare participantId toggle;
// 2 = the replay/dead/intent/clockSuspect fields (KIOSK_RESILIENCE §2);
// 3 = the kiosk filters repeat reads itself, so the server skips its debounce. The
// kiosk enables a generation's behavior only when /api/system-status/
// kiosk-version advertises it, so an auto-updating kiosk cannot race a
// not-yet-deployed server into misreading fields it does not know.
export const SCAN_PROTOCOL_VERSION = 3;

// Callers speaking at least this generation filter repeat reads before sending.
export const KIOSK_DEBOUNCE_PROTOCOL_VERSION = 3;
