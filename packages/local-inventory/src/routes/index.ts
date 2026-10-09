/**
 * Route-factory barrel. The host mounts each factory under /api/inventory/* by
 * wrapping it in its handler() from a re-export stub.
 */
export * as locations from "./locations";
export * as orgItems from "./orgItems";
export * as receiveQueue from "./receiveQueue";
export * as ledgers from "./ledgers";
export * as provisional from "./provisional";
