-- Decision 27 Nov 2026: a campaign with no any_trade value means "home services, any trade" = true, as in the
-- live app (command.ts reads `any_trade !== false`; new campaigns are created with true). The P1 import stored
-- false for campaigns whose record had no field. Those are exactly the campaigns created before 19 Nov 2026,
-- when the field was added (checked against the 26 Nov export: 9 campaigns, all older; the first with an explicit
-- value, false, is from 19 Nov and keeps it). The import is fixed too (scripts/db/transform.mjs), so a fresh
-- import at P5 gives true directly; on an empty database this update changes nothing.

alter table campaigns alter column any_trade set default true;

update campaigns set any_trade = true
where any_trade = false and created_at < timestamptz '2026-11-19 00:00:00+00';
