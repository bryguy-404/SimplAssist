BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a088-000000000001','booking-owner@example.test'),('00000000-0000-4000-a088-000000000002','other-booking@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan) VALUES
 ('10000000-0000-4000-a088-000000000001','00000000-0000-4000-a088-000000000001','Booking','general','booking-088','comped','full'),
 ('10000000-0000-4000-a088-000000000002','00000000-0000-4000-a088-000000000002','Other','general','other-088','comped','full');
INSERT INTO services(id,business_id,name) VALUES
 ('20000000-0000-4000-a088-000000000001','10000000-0000-4000-a088-000000000001','Estimate'),
 ('20000000-0000-4000-a088-000000000002','10000000-0000-4000-a088-000000000002','Other estimate');
SELECT ok(NOT has_function_privilege('authenticated','public.configure_booking_settings(uuid,uuid,integer,jsonb,jsonb)','EXECUTE'),'owners cannot bypass settings route');
SELECT ok(NOT has_table_privilege('authenticated','booking_drafts','INSERT'),'owner cannot manufacture confirmation');
SELECT ok(NOT has_table_privilege('anon','booking_notifications','SELECT'),'anonymous cannot read notifications');
SELECT is(configure_booking_settings('10000000-0000-4000-a088-000000000001','00000000-0000-4000-a088-000000000001',0,
 '{"format":"phone_callback","label":"Estimate","durationMinutes":60,"businessAddress":null}','[]'),1,'save increments revision');
SELECT throws_ok($$SELECT configure_booking_settings('10000000-0000-4000-a088-000000000001','00000000-0000-4000-a088-000000000001',0,
 '{"format":"phone_callback","label":"Estimate","durationMinutes":60,"businessAddress":null}','[]')$$,'40001','booking settings conflict','stale settings rejected');
SELECT throws_ok($$SELECT configure_booking_settings('10000000-0000-4000-a088-000000000001','00000000-0000-4000-a088-000000000002',1,
 '{"format":"phone_callback","label":"Estimate","durationMinutes":60,"businessAddress":null}','[]')$$,'42501','booking access denied','other owner rejected');
SELECT throws_ok($$SELECT configure_booking_settings('10000000-0000-4000-a088-000000000001','00000000-0000-4000-a088-000000000001',1,
 '{"format":"phone_callback","label":"Estimate","durationMinutes":60,"businessAddress":null}',
 '[{"serviceId":"20000000-0000-4000-a088-000000000002","setting":{"mode":"inherit"}}]')$$,'42501','booking service mismatch','cross-business service rejected');
SELECT ok(NOT valid_booking_offering('{"format":"business_visit","label":"Visit","durationMinutes":30,"businessAddress":null}'),'business visit requires approved address');
SELECT ok(NOT valid_booking_offering('{"format":"customer_site","label":"Visit","durationMinutes":45,"businessAddress":null}'),'duration limited to supported steps');
SELECT ok(NOT valid_booking_offering('{"format":"customer_site","durationMinutes":30,"businessAddress":null}'),'missing label rejected');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a088-000000000002',true);
SELECT is((SELECT count(*)::integer FROM booking_settings),0,'other owner cannot read settings');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a088-000000000001',true);
SELECT is((SELECT count(*)::integer FROM booking_settings),1,'owner can read settings');
RESET ROLE;
UPDATE businesses SET owner_id=NULL WHERE id='10000000-0000-4000-a088-000000000001';
SELECT is((SELECT count(*)::integer FROM booking_settings WHERE business_id='10000000-0000-4000-a088-000000000001'),0,'cleanup deletes retained configuration');
SELECT * FROM finish();
ROLLBACK;
