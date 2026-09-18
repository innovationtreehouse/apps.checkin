// Public entry for the global-catalog library. The domain surface checkin wires into
// (routes/auth/UI land in later tracks); track 1 is the domain + its own DB client.
export * as categoryService from "./services/categoryService";
export * as itemService from "./services/itemService";
export * as proposalService from "./services/proposalService";
export * as referenceMatchingService from "./services/referenceMatchingService";
export * as provisionalGtinService from "./services/provisionalGtinService";
export * as conversionChallengeService from "./services/conversionChallengeService";
export * as conflictResolutionService from "./services/conflictResolutionService";
export * as orgEventService from "./services/orgEventService";
export { prisma, db, getPrisma, initDb } from "./db";
export * from "./db/schema";
