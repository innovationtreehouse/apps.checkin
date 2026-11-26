/**
 * Non-Prisma response models the facility trends and front-desk contact sheet
 * reads ship through handler() (the catalogSyntheticClassifications.ts
 * pattern). They keep each route's wire shape and list only the fields that
 * leave.
 *
 * FacilityTrends / FacilityTrendBucket — GET /api/facility/trends: the
 * selected `period` and per-period attendance aggregates (`buckets`, plus one
 * `totals` bucket). Counts and hours only, no person or visit row, all
 * `internal`: the trends are a staff report.
 *
 * SafetyContactSheet — GET /api/safety/emergency-contacts: the `households`
 * list and the kiosk `building` link.
 *
 * SafetyContactHousehold — one household on the sheet: Household's id and name
 * at Household's tiers; the primary valid contact's name and phone
 * (`emergencyContactName`, `emergencyContactPhone`) at EmergencyContact's
 * `personal`; and `isPresent`, whether any member has an open visit, at
 * Visit.arrivedAt's `personal`. Its leads are HouseholdContactPerson rows
 * (membershipAuditSyntheticClassifications.ts).
 *
 * SafetyEmergencyContact — one of the household's contacts at
 * EmergencyContact's tiers, plus `invalid`, computed from the contact's own
 * fields and its internal conflict flag, so `internal`.
 *
 * SafetyHouseholdMember — a member's id and name at Person's tiers, and
 * `isPresent` at Visit.arrivedAt's `personal`.
 *
 * BuildingLink — whether the kiosk is reachable, when it was last heard and
 * how many scans it has queued (lib/kioskSeen.ts). Kiosk health, `internal`
 * like SystemMetricLog.
 *
 * None of these models is row-scoped: the views that read them grant
 * `everyones` tokens.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  FacilityTrends: {
    period: "internal",
  },
  FacilityTrendBucket: {
    label: "internal",
    periodStart: "internal",
    uniqueVolunteers: "internal",
    uniqueParticipants: "internal",
    totalVolunteerHours: "internal",
    totalParticipantHours: "internal",
    structuredHours: "internal",
    unstructuredHours: "internal",
    bySource: "internal",
  },
  SafetyContactSheet: {},
  SafetyContactHousehold: {
    id: "public",
    name: "public",
    emergencyContactName: "personal",
    emergencyContactPhone: "personal",
    isPresent: "personal",
  },
  SafetyEmergencyContact: {
    id: "public",
    name: "personal",
    phone: "personal",
    email: "personal",
    relationship: "personal",
    invalid: "internal",
  },
  SafetyHouseholdMember: {
    id: "public",
    name: "public",
    isPresent: "personal",
  },
  BuildingLink: {
    reachable: "internal",
    lastSeenAt: "internal",
    queued: "internal",
  },
} as const;

export const relations = {
  FacilityTrends: {
    buckets: { model: "FacilityTrendBucket", isList: true },
    totals: { model: "FacilityTrendBucket", isList: false },
  },
  SafetyContactSheet: {
    households: { model: "SafetyContactHousehold", isList: true },
    building: { model: "BuildingLink", isList: false },
  },
  SafetyContactHousehold: {
    emergencyContacts: { model: "SafetyEmergencyContact", isList: true },
    householdMembers: { model: "SafetyHouseholdMember", isList: true },
    leads: { model: "HouseholdContactPerson", isList: true },
  },
} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
