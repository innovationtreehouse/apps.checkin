// Not re-exported from index.ts, and package.json exports only ".", so callers write through
// findOrCreate / createVendor, which look the key up before every create. A registered symbol,
// so a second loaded copy of this module keys the same method.
export const CREATE = Symbol.for("@checkin/quickbooks.create");
// The in-kind journal-entry create, reachable only through findOrCreateInKindJournal.
export const CREATE_JOURNAL = Symbol.for("@checkin/quickbooks.create-journal");
