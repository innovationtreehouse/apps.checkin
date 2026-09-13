/**
 * Route-factory barrel (#1286 track 4). The host mounts each factory under
 * /api/catalog/* by wrapping it in checkin's handler() from a re-export stub;
 * the factories here stay host-free (see contract.ts / runtime.ts).
 */
export * as categories from "./categories";
export * as subcategories from "./subcategories";
export * as items from "./items";
export * as itemReferences from "./itemReferences";
export * as proposals from "./proposals";
export * as provisionalItems from "./provisionalItems";
export * as referenceConflicts from "./referenceConflicts";
export * as conversionChallenges from "./conversionChallenges";
export * as audit from "./audit";
