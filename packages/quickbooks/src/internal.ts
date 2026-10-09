// Not re-exported from index.ts, and package.json exports only ".", so code outside this
// package cannot reach the raw create: it writes through findOrCreate / createVendor, which
// look the key up before every create.
export const CREATE = Symbol("quickbooks.create");
