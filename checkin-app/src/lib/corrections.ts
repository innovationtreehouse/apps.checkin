// The corrections feed's row cap. Shared because both halves must agree: the
// route fetches MAX_ROWS + 1 so the extra row is the "there's more" signal, and
// the page trims it and reports "500+" rather than a wrong total. The count
// cannot ride in the response — it is not a model field, so the stripper drops
// it — which is why the client has to know the number out of band.
//
// ponytail: a guess, not a measurement — tighten once someone counts real
// AuditLog rows at tableName='Visit'.
export const MAX_ROWS = 500;
