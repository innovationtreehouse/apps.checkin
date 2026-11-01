// The scan-body generation this server speaks. 1 = bare participantId toggle;
// 2 = the replay/dead/intent/clockSuspect fields (KIOSK_RESILIENCE §2);
// 3 = the kiosk filters repeat reads itself, so the server skips its debounce;
// 5 = shownEmpty; late replays apply and are flagged instead of parking;
// 6 = the kiosk's `close` request (docs/rules/attendance-checkin.md, Opening and
// closing); 7 = a replay the server cannot apply parks for review instead of a
// 4xx, so the kiosk drain only ever acks or retries; 8 = scanTimeUncertaintyMs,
// the scan time rebased on the server's `Date` header. The kiosk enables a
// generation's behavior only when /api/system-status/kiosk-version advertises
// it, so an auto-updating kiosk cannot race a not-yet-deployed server into
// misreading fields it does not know.
export const SCAN_PROTOCOL_VERSION = 8;

// Callers speaking at least this generation filter repeat reads before sending.
export const KIOSK_DEBOUNCE_PROTOCOL_VERSION = 3;

// Callers speaking at least this generation have their late replays applied
// and flagged rather than parked.
export const TRUSTED_REPLAY_PROTOCOL_VERSION = 5;

// Callers speaking at least this generation send `close` to close the building;
// below it, a keyholder's checkout still decides the close.
export const CLOSE_REQUEST_PROTOCOL_VERSION = 6;
