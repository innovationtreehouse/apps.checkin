/**
 * Route-factory barrel. The host mounts each factory under /api/donations/* by
 * wrapping it in its handler() (or fileHandler() for the download) from a re-export stub.
 */
export * as uploads from "./uploads";
export * as transactions from "./transactions";
export * as rules from "./rules";
export * as disbursements from "./disbursements";
