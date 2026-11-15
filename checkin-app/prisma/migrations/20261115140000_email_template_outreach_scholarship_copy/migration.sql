BEGIN;
-- Copy the Board's outreach and scholarship-ACK wording from BoardSettings into
-- EmailTemplate rows. The BoardSettings columns stay as they are, because the
-- previous release still reads them. A key that already has a row keeps it, and
-- a blank subject and body make no row, so that key sends its registry default.
-- Outreach now sends only to member households, so {{actionWord}} becomes "renew".
-- A template body is plain text, so outreach copy written as HTML makes no row and
-- that campaign sends its default.
-- The ACK subject goes to all three ACK rows; the membership and hold-failed ACKs
-- have no {{programName}} token, so it becomes empty there, as it rendered before.
INSERT INTO "EmailTemplate" ("key", "subject", "body", "updatedAt")
SELECT v."key", v."subject", v."body", NOW()
FROM "BoardSettings" b
CROSS JOIN LATERAL (VALUES
    ('outreach.opening',
        regexp_replace(COALESCE(b."outreachOpeningSubject", ''), '\{\{\s*actionWord\s*\}\}', 'renew', 'g'),
        regexp_replace(COALESCE(b."outreachOpeningBody", ''), '\{\{\s*actionWord\s*\}\}', 'renew', 'g')),
    ('outreach.reminder',
        regexp_replace(COALESCE(b."outreachReminderSubject", ''), '\{\{\s*actionWord\s*\}\}', 'renew', 'g'),
        regexp_replace(COALESCE(b."outreachReminderBody", ''), '\{\{\s*actionWord\s*\}\}', 'renew', 'g')),
    ('scholarship.ackMembership',
        replace(btrim(COALESCE(b."scholarshipAckSubject", '')), '{{programName}}', ''),
        replace(COALESCE(b."scholarshipAckMembershipBody", ''), '{{programName}}', '')),
    ('scholarship.ackProgram',
        btrim(COALESCE(b."scholarshipAckSubject", '')),
        COALESCE(b."scholarshipAckProgramBody", '')),
    ('scholarship.ackProgramHoldFailed',
        replace(btrim(COALESCE(b."scholarshipAckSubject", '')), '{{programName}}', ''),
        '')
) AS v("key", "subject", "body")
WHERE b."id" = 1
    AND (v."subject" ~ '\S' OR v."body" ~ '\S')
    AND NOT (v."key" LIKE 'outreach.%' AND (v."subject" || v."body") ~ '<[A-Za-z/!]')
ON CONFLICT ("key") DO NOTHING;
COMMIT;
