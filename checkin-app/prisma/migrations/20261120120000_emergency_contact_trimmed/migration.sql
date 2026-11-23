BEGIN;

-- Name and phone are stored trimmed, so "non-empty" is the whole validity test
-- (lib/emergencyContacts/valid.ts). Every writer already trims; this normalises
-- existing rows, then constrains. \s matches space, tab, newline, CR, VT and FF.
UPDATE "EmergencyContact"
SET "name" = regexp_replace("name", '^\s+|\s+$', '', 'g'),
    "phone" = regexp_replace("phone", '^\s+|\s+$', '', 'g')
WHERE "name" ~ '^\s|\s$' OR "phone" ~ '^\s|\s$';

ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_name_trimmed" CHECK ("name" !~ '^\s|\s$');
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_phone_trimmed" CHECK ("phone" !~ '^\s|\s$');

COMMIT;
