BEGIN;

-- Nullable until a later release: code still serving the deploy drain inserts programs without it.
ALTER TABLE "Program" ADD COLUMN "nameKey" TEXT;

-- Trims the characters JavaScript's String.prototype.trim does, so the key matches lib/programs/nameKey.ts.
UPDATE "Program" SET "name" = regexp_replace("name", '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$', '', 'g');
UPDATE "Program" SET "nameKey" = lower("name");

-- Fails if two programs in one membership year share a name ignoring case and outer spaces;
-- rename one in the app before releasing.
CREATE UNIQUE INDEX "Program_nameKey_appliesToYear_key" ON "Program"("nameKey", "appliesToYear");

COMMIT;
