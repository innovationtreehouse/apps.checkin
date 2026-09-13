import type { ConflictResolution } from "../db/schema";

export type ConflictResolutionEvent = { type: "RESOLVE"; resolution: ConflictResolution };
