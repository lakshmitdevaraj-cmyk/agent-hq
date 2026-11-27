-- A1 (P2 chunk 4): the duplicate check on adding a lead looks across all campaigns at the phone number and the
-- Google place id. Expression indexes, so no new column and nothing for the import to fill. The queries in
-- netlify/functions/lib/sql/addlead.ts and leadgen.ts use exactly these expressions.
create index leads_phone_key on leads (right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10));
create index leads_place_id on leads ((data->'raw'->>'placeId'));
