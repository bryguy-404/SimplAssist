BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES
 ('00000000-0000-4000-a115-000000000001','upgrade-owner@example.test'),
 ('00000000-0000-4000-a115-000000000002','upgrade-other@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode)
VALUES
 ('10000000-0000-4000-a115-000000000001','00000000-0000-4000-a115-000000000001','Upgrade Business','general','upgrade-prefs-115','stripe'),
 ('10000000-0000-4000-a115-000000000002','00000000-0000-4000-a115-000000000002','Other Business','general','upgrade-other-115','stripe');
CREATE FUNCTION pg_temp.save_pref(action text, revision integer, offer text DEFAULT 'review_texting') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.save_dashboard_upgrade_preference('10000000-0000-4000-a115-000000000001','00000000-0000-4000-a115-000000000001',offer,action,revision);
$$;
SELECT ok(NOT has_table_privilege('anon','dashboard_upgrade_preferences','SELECT'),'anonymous callers cannot read preference state');
SELECT ok(NOT has_table_privilege('authenticated','dashboard_upgrade_preferences','UPDATE'),'owners cannot bypass atomic preference updates');
SELECT ok(NOT has_function_privilege('authenticated','save_dashboard_upgrade_preference(uuid,uuid,text,text,integer)','EXECUTE'),'RPC callable only by service');
SELECT throws_ok($$SELECT save_dashboard_upgrade_preference('10000000-0000-4000-a115-000000000001','00000000-0000-4000-a115-000000000002','review_texting','snooze',0)$$,'42501','upgrade_prompt_forbidden','other owner cannot dismiss suggestions');
SELECT throws_ok($$SELECT pg_temp.save_pref('purchase',0)$$,'22023','upgrade_prompt_invalid','preference API never purchases anything');
SELECT throws_ok($$SELECT pg_temp.save_pref('snooze',0,'unknown')$$,'22023','upgrade_prompt_invalid','unsupported offer rejected');
SELECT throws_ok($$SELECT pg_temp.save_pref('snooze',NULL)$$,'22023','upgrade_prompt_invalid','revision required');
SELECT is(pg_temp.save_pref('snooze',0)->>'revision','1','first dismissal creates one revision');
SELECT is((SELECT snoozed_until FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),now()+interval '7 days','first dismissal snoozed for seven days');
SELECT throws_ok($$SELECT pg_temp.save_pref('snooze',0)$$,'40001','upgrade_prompt_changed','replayed or concurrent stale request cannot count twice');
SELECT is((SELECT dismissal_count FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),1,'duplicate request did not increment count');
SELECT is(pg_temp.save_pref('snooze',1)->>'dismissal_count','2','second dismissal recorded');
SELECT is((SELECT snoozed_until FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),now()+interval '7 days','second dismissal still seven days');
SELECT is(pg_temp.save_pref('snooze',2)->>'dismissal_count','3','third dismissal recorded');
SELECT is((SELECT snoozed_until FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),now()+interval '30 days','third dismissal slows to thirty days');
SELECT is(pg_temp.save_pref('snooze',3)->>'dismissal_count','4','later dismissal recorded');
SELECT is((SELECT snoozed_until FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),now()+interval '30 days','later dismissals stay thirty days');
SELECT is(pg_temp.save_pref('hide',4)->>'revision','5','permanent hide has independent revision');
SELECT ok((SELECT hidden_at IS NOT NULL AND snoozed_until IS NULL FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),'hidden preference does not expire');
SELECT is(pg_temp.save_pref('snooze',0,'growth')->>'dismissal_count','1','next offer has independent preferences');
SELECT ok((SELECT hidden_at IS NOT NULL FROM dashboard_upgrade_preferences WHERE offer_key='review_texting'),'another offer does not clear permanent hide');
SELECT is((SELECT count(*)::integer FROM sms_billing_operations WHERE business_id='10000000-0000-4000-a115-000000000001'),0,'preference changes create no billing operation');
SELECT is((SELECT count(*)::integer FROM review_sms_accounts WHERE business_id='10000000-0000-4000-a115-000000000001'),0,'preference changes create no provider setup');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a115-000000000001',true);
SELECT is((SELECT count(*)::integer FROM public.dashboard_upgrade_preferences),2,'owner reads only its two offer preferences');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a115-000000000002',true);
SELECT is((SELECT count(*)::integer FROM public.dashboard_upgrade_preferences),0,'different owner cannot read another business preferences');
RESET ROLE;
UPDATE businesses SET operations_suspended_at=now() WHERE id='10000000-0000-4000-a115-000000000001';
SELECT throws_ok($$SELECT pg_temp.save_pref('hide',1,'growth')$$,'42501','upgrade_prompt_forbidden','suspended account cannot mutate preferences');
SELECT * FROM finish();
ROLLBACK;
