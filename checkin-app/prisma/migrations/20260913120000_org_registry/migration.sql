-- Organization registry (#1286 §6). Additive, expand-only: a brand-new table no
-- code on origin/main reads or writes, so old tasks keep serving through the
-- drain window. checkin is single-org — the Treehouse row (stable well-known id
-- "treehouse") is written by the seed, not here — but the table lets multi-org
-- later be more rows, not a schema/config rewrite. Both columns are public
-- reference data (no PII). Single statement: no BEGIN/COMMIT needed.
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);
