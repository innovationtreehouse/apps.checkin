// Public surface of the @inventory/income library (S: domain only — routes, pages and the
// auth port land in W).
export * from "./contract";
export * from "./runtime";
export * from "./db";
export * from "./db/schema";
export * from "./lib/audit";
export * from "./lib/deposit-lines";
export * from "./lib/qb-deposits";
export * from "./lib/reconcile";
export * from "./services/reconciliationService";
export * from "./services/serviceError";
export { seedIncomeDev } from "./seed";
