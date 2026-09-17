BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
-- These authority tests retain protocol 0 so the public disclosure suite can
-- independently verify protocol 1 without mixing transport concerns here.
ALTER TABLE public.voice_sessions ALTER COLUMN disclosure_version SET DEFAULT 0;
CREATE TEMP TABLE buyers(n integer PRIMARY KEY,b uuid,o uuid,operation uuid);
CREATE FUNCTION pg_temp.paid(n integer,prior_plan text DEFAULT NULL,p_business uuid DEFAULT gen_random_uuid()) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE owner uuid:=gen_random_uuid(); operation jsonb; source_start timestamptz; source_end timestamptz;
  sid text:='sub_public85'||n; cid text:='cus_public85'||n; kind text:=CASE WHEN prior_plan IS NULL THEN 'checkout' ELSE 'upgrade' END;
BEGIN
  INSERT INTO auth.users(id,email) VALUES(owner,'voice-public85-'||n||'@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(p_business,owner,'Public voice','general','voice-public85-'||n);
  INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active)
    VALUES(p_business,CASE WHEN n=9 THEN '+15742638634' ELSE '+15555551'||lpad(n::text,3,'0') END,'public85-number-'||n,true);
  IF prior_plan IS NOT NULL THEN
    source_start:=now()-interval '10 days';source_end:=now()+interval '20 days';
    INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
      VALUES(p_business,cid,sid,prior_plan,'active',source_start,source_end);
  END IF;
  operation:=public.acquire_sms_billing_operation(p_business,owner,jsonb_build_object('kind',kind,'target_plan','full','target_price_id','price_full85',
    'source_fingerprint',repeat('a',64),'expected_subscription_id',CASE WHEN prior_plan IS NOT NULL THEN sid END,
    'expected_customer_id',CASE WHEN prior_plan IS NOT NULL THEN cid END,'proration_at',now()));
  PERFORM public.confirm_sms_billing_operation((operation->>'id')::uuid,owner,repeat('a',64));
  PERFORM public.record_sms_billing_operation((operation->>'id')::uuid,jsonb_build_object('stripe_customer_id',cid,'stripe_subscription_id',sid,'state','pending'));
  IF n=9 THEN
    INSERT INTO public.voice_pilot_settings(business_id,enabled) VALUES(p_business,true);
    INSERT INTO public.voice_pilot_testers(business_id,phone_number,prior_disclosure_acknowledged_at) VALUES(p_business,'+15555559999',now()-interval '1 day');
    -- A real existing pilot call is admitted before the paid upgrade retires it.
    PERFORM public.admit_voice_pilot(p_business,'public85-old-pilot','public85-old-session','+15555559999','+15742638634',true);
  END IF;
  PERFORM public.finalize_paid_sms_billing_operation((operation->>'id')::uuid,
    jsonb_build_object('subscription_id',sid,'customer_id',cid,'plan','full','status','active','price_id','price_full85',
      'period_start',COALESCE(source_start,now()),'period_end',COALESCE(source_end,now()+interval '30 days')),
    jsonb_build_object('status','paid','invoice_id','in_public85'||n,'subscription_id',sid,'customer_id',cid,'paid_at',now()));
  INSERT INTO buyers VALUES(n,p_business,owner,(operation->>'id')::uuid);
  RETURN p_business;
END $$;
SELECT pg_temp.paid(n) FROM generate_series(1,4)n;
SELECT pg_temp.paid(5,'sms_and_chat');
SELECT ok(NOT (SELECT enabled FROM public.voice_rollout_control),'migration leaves public rollout closed');
SELECT is((SELECT max_concurrent_calls FROM public.voice_rollout_control),2,'migration retains capacity until load verification');
SELECT is((SELECT count(*)::integer FROM public.voice_rollout_businesses WHERE business_id IN(SELECT b FROM buyers)),0,'paid enrollment needs no business allowlist');
SELECT is((SELECT primary_response FROM public.voice_commercial_settings WHERE business_id=(SELECT b FROM buyers WHERE n=1)),'text','new paid owner defaults to Text');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM buyers WHERE n=1)),6000,'initial paid month grants 100 minutes');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM buyers WHERE n=5)),4000,'paid upgrade uses original payment time for remaining 20 of 30 days');
SELECT ok(NOT has_function_privilege('authenticated','public.record_voice_billing_payment(uuid,bigint,text,text,text,timestamptz,timestamptz,timestamptz)','EXECUTE'),'owner cannot fabricate paid invoice proof');
SELECT ok(NOT has_table_privilege('authenticated','public.voice_billing_payments','SELECT'),'provider payment identities are not owner-readable');
SELECT throws_ok($$UPDATE public.voice_billing_payments SET paid_at=now()+interval '1 second' WHERE invoice_id='in_public851'$$,
  '55000','voice payment evidence is immutable','verified invoice date cannot be rewritten');
SELECT throws_ok($$DELETE FROM public.voice_billing_payments WHERE invoice_id='in_public851'$$,
  '55000','voice payment evidence cannot be deleted','proof cannot be erased and replayed');
SELECT lives_ok($$SELECT public.apply_paid_sms_voice_entitlement(b,operation,'sms_and_chat','sub_public855',now()-interval '10 days',now()+interval '20 days') FROM buyers WHERE n=5$$,
  'paid hook retry is idempotent');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM buyers WHERE n=5)),1,'hook retry adds no second grant');
UPDATE public.voice_rollout_control SET enabled=true,max_concurrent_calls=4;
SELECT is(public.voice_commercial_access_reason((SELECT b FROM buyers WHERE n=1)),NULL::text,'verified paid account is publicly eligible without membership');
INSERT INTO public.voice_rollout_businesses(business_id,enabled,emergency_stop) SELECT b,false,false FROM buyers WHERE n=1;
SELECT is(public.voice_commercial_access_reason((SELECT b FROM buyers WHERE n=1)),NULL::text,'legacy enabled=false is not a private access restriction');
UPDATE public.voice_rollout_businesses SET emergency_stop=true WHERE business_id=(SELECT b FROM buyers WHERE n=1);
SELECT is(public.voice_commercial_access_reason((SELECT b FROM buyers WHERE n=1)),'rollout_closed','optional business emergency stop still blocks voice');
UPDATE public.voice_rollout_businesses SET emergency_stop=false WHERE business_id=(SELECT b FROM buyers WHERE n=1);
SELECT public.configure_voice_commercial(b,'voice',false,1,o) FROM buyers;
CREATE TEMP TABLE calls(n integer,id uuid);
INSERT INTO calls SELECT 1,(public.admit_voice_commercial(b,'public85-call1','public85-session1','+15555559999','+15555551001',true)).id FROM buyers WHERE n=1;
INSERT INTO calls SELECT 2,(public.admit_voice_commercial(b,'public85-call2','public85-session2','+15555559998','+15555551001',true)).id FROM buyers WHERE n=1;
INSERT INTO calls SELECT 3,(public.admit_voice_commercial(b,'public85-call3','public85-session3','+15555559997','+15555551001',true)).id FROM buyers WHERE n=1;
SELECT is((SELECT outcome FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=3)),'capacity_unavailable','a third call at one business is refused despite free fleet capacity');
INSERT INTO calls SELECT 4,(public.admit_voice_commercial(b,'public85-call4','public85-session4','+15555559999','+15555551002',true)).id FROM buyers WHERE n=2;
INSERT INTO calls SELECT 5,(public.admit_voice_commercial(b,'public85-call5','public85-session5','+15555559999','+15555551003',true)).id FROM buyers WHERE n=3;
INSERT INTO calls SELECT 6,(public.admit_voice_commercial(b,'public85-call6','public85-session6','+15555559999','+15555551004',true)).id FROM buyers WHERE n=4;
SELECT is((SELECT count(*)::integer FROM public.voice_sessions WHERE id IN(SELECT id FROM calls) AND response_mode='voice'),4,'four total calls are admitted across independent businesses');
SELECT is((SELECT outcome FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=6)),'capacity_unavailable','fifth fleet call receives a frozen denial');
SELECT ok(NOT (SELECT text_fallback_enabled FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=6)),'capacity denial preserves no-text preference');
SELECT is((public.admit_voice_commercial((SELECT b FROM buyers WHERE n=1),'public85-call1','public85-session1','+15555559999','+15555551001',true)).id,
  (SELECT id FROM calls WHERE n=1),'retry returns the existing slot and reservation');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE business_id IN(SELECT b FROM buyers)),4,'denial and retries create no additional holds');

-- Commercial actions preserve the shared executor's current business policies.
UPDATE public.voice_sessions SET status='active',started_at=clock_timestamp(),notice_completed_at=clock_timestamp() WHERE id=(SELECT id FROM calls WHERE n=1);
UPDATE public.businesses SET primary_goal='book' WHERE id=(SELECT b FROM buyers WHERE n=1);
INSERT INTO public.ai_settings(business_id,booking_enabled,booking_mode) SELECT b,true,'schedule_direct' FROM buyers WHERE n=1
  ON CONFLICT(business_id) DO UPDATE SET booking_enabled=true,booking_mode='schedule_direct';
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'direct booking requires the business calendar');
INSERT INTO public.google_calendar_tokens(business_id,access_token,refresh_token,token_expiry,google_email) SELECT b,'fixture','fixture',now()+interval '1 day','calendar85@example.test' FROM buyers WHERE n=2;
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'another business calendar grants no access');
INSERT INTO public.google_calendar_tokens(business_id,access_token,refresh_token,token_expiry,google_email) SELECT b,'fixture','fixture',now()+interval '1 day','calendar85@example.test' FROM buyers WHERE n=1;
SELECT ok(public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'active direct-booking business with connected calendar is permitted');
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking_request'),'direct mode cannot silently create a request');
UPDATE public.ai_settings SET booking_mode='collect_info' WHERE business_id=(SELECT b FROM buyers WHERE n=1);
SELECT ok(public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking_request'),'collect mode explicitly permits an appointment request');
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'collect mode cannot submit a confirmed booking');
UPDATE public.ai_settings SET booking_mode='schedule_direct' WHERE business_id=(SELECT b FROM buyers WHERE n=1);
UPDATE public.businesses SET bookings_paused_at=now() WHERE id=(SELECT b FROM buyers WHERE n=1);
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'operational booking pause is current');
UPDATE public.businesses SET bookings_paused_at=NULL,primary_goal='signup',goal_url='https://example.test/signup' WHERE id=(SELECT b FROM buyers WHERE n=1);
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'signup goal never enables calendar actions');
SELECT ok(public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'signup'),'signup goal permits existing independently checked SMS send');
UPDATE public.subscriptions SET status='canceled' WHERE business_id=(SELECT b FROM buyers WHERE n=1);
SELECT ok(public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'contact'),'bounded existing call can still save confirmed contact after ordinary cancellation');
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'signup'),'cancellation denies paid SMS action');
UPDATE public.voice_rollout_businesses SET emergency_stop=true WHERE business_id=(SELECT b FROM buyers WHERE n=1);
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'contact'),'business emergency stop revokes all live actions');
UPDATE public.voice_rollout_businesses SET emergency_stop=false WHERE business_id=(SELECT b FROM buyers WHERE n=1);
DO $$ DECLARE v record; BEGIN
  FOR v IN SELECT * FROM public.voice_sessions WHERE id IN(SELECT id FROM calls) AND response_mode='voice' LOOP
    PERFORM public.record_voice_customer_start(v.id,'done-start',v.created_at);
    PERFORM public.acknowledge_voice_customer_start(v.id,'done-start');
    PERFORM public.record_voice_customer_end(v.id,'done-end',clock_timestamp());
    PERFORM public.finalize_voice_session(v.id,'caller_hangup',NULL,false);
  END LOOP;
END $$;

-- A fresh active flag is not payment proof for a renewal. Retained past-cycle
-- fixtures model a legitimate historic purchase without replaying an old charge.
CREATE TEMP TABLE renewal(b uuid,o uuid,op uuid);
INSERT INTO renewal VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
INSERT INTO auth.users(id,email) SELECT o,'voice-public85-renewal@example.test' FROM renewal;
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) SELECT b,o,'Renewal','general','voice-public85-renewal' FROM renewal;
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
  SELECT b,'cus_public85renewal','sub_public85renewal','full','active',now()-interval '31 days',now()-interval '1 day' FROM renewal;
INSERT INTO public.sms_billing_operations(id,business_id,owner_id,kind,state,target_plan,target_price_id,stripe_customer_id,stripe_subscription_id,
  source_fingerprint,created_at,expires_at,confirmed_at,applied_at,invoice_id,payment_effective_at,payment_verified_at)
  SELECT op,b,o,'checkout','applied','full','price_full85','cus_public85renewal','sub_public85renewal',repeat('a',64),now()-interval '31 days',
    now()-interval '30 days',now()-interval '31 days',now()-interval '31 days','in_public85old',now()-interval '31 days',now()-interval '31 days' FROM renewal;
INSERT INTO public.voice_commercial_settings(business_id) SELECT b FROM renewal;
INSERT INTO public.voice_billing_projection(business_id,subscription_id,requested_revision,applied_revision,plan,status,period_start,period_end,verified_at,entitlement_operation_id)
  SELECT b,'sub_public85renewal',1,1,'full','active',now()-interval '31 days',now()-interval '1 day',now()-interval '31 days',op FROM renewal;
INSERT INTO public.voice_billing_payments(invoice_id,business_id,subscription_id,customer_id,period_start,period_end,paid_at)
  SELECT 'in_public85old',b,'sub_public85renewal','cus_public85renewal',now()-interval '31 days',now()-interval '1 day',now()-interval '31 days' FROM renewal;
INSERT INTO public.voice_allowance_periods(business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
  SELECT b,'sub_public85renewal',now()-interval '31 days',now()-interval '1 day',6000,now()-interval '31 days' FROM renewal;
SELECT public.begin_voice_billing_reconciliation(b,'sub_public85renewal','cus_public85renewal') FROM renewal;
UPDATE public.subscriptions SET current_period_start=now()-interval '1 day',current_period_end=now()+interval '29 days' WHERE business_id=(SELECT b FROM renewal);
SELECT ok(public.apply_voice_billing_projection((SELECT b FROM renewal),2,'sub_public85renewal','full','active',now()-interval '1 day',now()+interval '29 days',false,now()),
  'unpaid renewal status can synchronize safely');
SELECT is(public.voice_commercial_access_reason((SELECT b FROM renewal)),'billing_pending','active renewal cannot use last month payment');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM renewal)),1,'unpaid renewal gets no new allowance');
SELECT public.begin_voice_billing_reconciliation(b,'sub_public85renewal','cus_public85renewal') FROM renewal;
SELECT ok(NOT public.record_voice_billing_payment((SELECT b FROM renewal),2,'sub_public85renewal','cus_public85renewal','in_public85renewal',
 now()-interval '1 day',now()+interval '29 days',now()-interval '1 day'),'stale reconciliation ticket cannot attach payment');
SELECT ok(public.record_voice_billing_payment((SELECT b FROM renewal),3,'sub_public85renewal','cus_public85renewal','in_public85renewal',
 now()-interval '1 day',now()+interval '29 days',now()-interval '1 day'),'paid renewal evidence binds current ticket and source');
SELECT throws_ok($$SELECT public.record_voice_billing_payment((SELECT b FROM renewal),3,'sub_public85renewal','cus_public85renewal','in_public85renewal',
 now()-interval '1 day',now()+interval '28 days',now()-interval '1 day')$$,'23514','voice payment identity mismatch','invoice proof cannot be moved to another billing period');
SELECT ok(public.apply_voice_billing_projection((SELECT b FROM renewal),3,'sub_public85renewal','full','active',now()-interval '1 day',now()+interval '29 days',false,now()),
  'verified paid renewal applies');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM renewal) AND period_start=now()-interval '1 day'),6000,'normal paid renewal receives full month, even if recovery is later');
SELECT is(public.voice_commercial_access_reason((SELECT b FROM renewal)),NULL::text,'verified renewal is publicly eligible');

-- Re-upgrading an already used period never tops up the frozen allowance.
INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,period_id,reserved_seconds,settled_seconds,state,settled_at)
  SELECT gen_random_uuid(),encode(extensions.digest('public85-spent','sha256'),'hex'),b,a.id,600,123,'settled',now()
  FROM buyers JOIN public.voice_allowance_periods a ON a.business_id=buyers.b WHERE n=5;
UPDATE public.subscriptions SET plan='sms_and_chat' WHERE business_id=(SELECT b FROM buyers WHERE n=5);
SELECT public.apply_voice_billing_projection(b,public.begin_voice_billing_reconciliation(b,'sub_public855','cus_public855'),
  'sub_public855','sms_and_chat','active',now()-interval '10 days',now()+interval '20 days',false,now()) FROM buyers WHERE n=5;
CREATE TEMP TABLE reupgrade AS SELECT public.acquire_sms_billing_operation(b,o,jsonb_build_object('kind','upgrade','target_plan','full','target_price_id','price_full85',
  'source_fingerprint',repeat('c',64),'expected_subscription_id','sub_public855','expected_customer_id','cus_public855','proration_at',now())) AS operation FROM buyers WHERE n=5;
SELECT public.confirm_sms_billing_operation((operation->>'id')::uuid,(SELECT o FROM buyers WHERE n=5),repeat('c',64)) FROM reupgrade;
SELECT public.record_sms_billing_operation((operation->>'id')::uuid,'{"stripe_customer_id":"cus_public855","stripe_subscription_id":"sub_public855","state":"pending"}') FROM reupgrade;
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT (operation->>'id')::uuid FROM reupgrade),
  jsonb_build_object('subscription_id','sub_public855','customer_id','cus_public855','plan','full','status','active','price_id','price_full85','period_start',now()-interval '10 days','period_end',now()+interval '20 days'),
  jsonb_build_object('status','paid','invoice_id','in_public85reupgrade','subscription_id','sub_public855','customer_id','cus_public855','paid_at',now())),
  'a confirmed paid re-upgrade can restore access');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM buyers WHERE n=5)),1,'same-period re-upgrade cannot mint another allowance');
SELECT is(public.get_voice_commercial_summary((SELECT b FROM buyers WHERE n=5))->>'used_seconds','123','same-period re-upgrade retains spent customer minutes');
SELECT is(public.get_voice_commercial_summary((SELECT b FROM buyers WHERE n=5))->>'available_seconds','3877','re-upgrade preserves original 4000 seconds less actual use');
SELECT throws_ok($$SELECT public.apply_paid_sms_voice_entitlement(b,operation,'sms_and_chat','sub_public855',now()-interval '10 days',now()+interval '20 days') FROM buyers WHERE n=5$$,
 '23514','voice enrollment superseded','older paid operation cannot replace the current same-source authority');

-- Rejoin is a new owner-confirmed payment and source, never an arbitrary webhook.
UPDATE public.subscriptions SET status='canceled' WHERE business_id=(SELECT b FROM buyers WHERE n=5);
CREATE TEMP TABLE rejoin AS SELECT public.acquire_sms_billing_operation(b,o,jsonb_build_object('kind','checkout','target_plan','full','target_price_id','price_full85',
  'source_fingerprint',repeat('b',64),'expected_subscription_id','sub_public855','expected_customer_id','cus_public855',
  'previous_source_terminal_status','canceled','previous_source_terminal_verified_at',clock_timestamp())) AS operation FROM buyers WHERE n=5;
SELECT public.confirm_sms_billing_operation((operation->>'id')::uuid,(SELECT o FROM buyers WHERE n=5),repeat('b',64)) FROM rejoin;
SELECT public.record_sms_billing_operation((operation->>'id')::uuid,'{"stripe_customer_id":"cus_public855","stripe_subscription_id":"sub_public85replacement","state":"pending"}') FROM rejoin;
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT (operation->>'id')::uuid FROM rejoin),
  jsonb_build_object('subscription_id','sub_public85replacement','customer_id','cus_public855','plan','full','status','active','price_id','price_full85','period_start',now(),'period_end',now()+interval '30 days'),
  jsonb_build_object('status','paid','invoice_id','in_public85replacement','subscription_id','sub_public85replacement','customer_id','cus_public855','paid_at',now())),
  'paid rejoin atomically replaces canonical source');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM buyers WHERE n=5)),2,'rejoin retains old spent pool and creates only its paid new month');
SELECT is(public.begin_voice_billing_reconciliation((SELECT b FROM buyers WHERE n=5),'sub_public855','cus_public855'),-1::bigint,'former subscription webhook cannot regain authority');
SELECT is((SELECT stripe_subscription_id FROM public.subscriptions WHERE business_id=(SELECT b FROM buyers WHERE n=5)),'sub_public85replacement','stale source did not overwrite current billing');
SELECT throws_ok($$SELECT public.apply_paid_sms_voice_entitlement(b,operation,'sms_and_chat','sub_public855',now()-interval '10 days',now()+interval '20 days') FROM buyers WHERE n=5$$,
 '23514','voice enrollment payment unverified','old paid operation replay cannot rebind a replaced source');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM buyers WHERE n=5)),2,'old paid operation replay does not mint a grant');

-- Bryan's ordinary paid upgrade retires the private exception permanently.
SELECT pg_temp.paid(9,'sms_and_chat','ea848911-ef72-44a6-8cf3-c47b3959be26');
SELECT ok((SELECT retired_at IS NOT NULL FROM public.voice_pilot_settings WHERE business_id=(SELECT b FROM buyers WHERE n=9)),'verified normal purchase permanently retires pilot');
SELECT is((SELECT primary_response FROM public.voice_commercial_settings WHERE business_id=(SELECT b FROM buyers WHERE n=9)),'voice','pilot transition preserves selected Voice');
SELECT is(public.get_voice_commercial_summary((SELECT b FROM buyers WHERE n=9))->>'access_source','commercial','dashboard switches to monthly pool while preserving history');
SELECT is((SELECT access_source FROM public.voice_sessions WHERE call_control_id='public85-old-pilot'),'pilot','previous pilot call keeps lifetime accounting');
SELECT ok((public.prepare_preinformed_voice_session((SELECT id FROM public.voice_sessions WHERE call_control_id='public85-old-pilot'))).id IS NOT NULL,'already-admitted pilot call can still start during retirement drain');
SELECT is((public.admit_voice_pilot((SELECT b FROM buyers WHERE n=9),'public85-new-private','new-private','+15555559999','+15742638634',true)).id,NULL::uuid,'retired account cannot admit a new tester bypass');
UPDATE public.voice_sessions SET status='closed' WHERE call_control_id='public85-old-pilot';
INSERT INTO calls SELECT 9,(public.admit_voice_commercial(b,'public85-retired-first','retired-first','+15555559999','+15742638634',true)).id FROM buyers WHERE n=9;
INSERT INTO calls SELECT 10,(public.admit_voice_commercial(b,'public85-retired-second','retired-second','+15555559998','+15742638634',true)).id FROM buyers WHERE n=9;
SELECT is((SELECT response_mode FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=9)),'voice','retired pilot takes ordinary commercial calls');
SELECT is((SELECT outcome FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=10)),'capacity_unavailable','unresolved closed pilot and new commercial call share the two-call business cap');
UPDATE public.voice_sessions SET phone_ended_at=clock_timestamp() WHERE call_control_id='public85-old-pilot';
SELECT is((public.admit_voice_commercial((SELECT b FROM buyers WHERE n=9),'public85-after-proof','after-proof','+15555559997','+15742638634',true)).response_mode,'voice','verified old pilot phone end releases exactly its capacity slot');
SELECT is((public.prepare_preinformed_voice_session((SELECT id FROM calls WHERE n=9))).id,NULL::uuid,'commercial call can never reuse private tester disclosure');
SELECT is((public.claim_voice_preparation((SELECT id FROM calls WHERE n=9))).id,NULL::uuid,'commercial call cannot use private prewarming');
UPDATE public.subscriptions SET plan='sms_and_chat' WHERE business_id=(SELECT b FROM buyers WHERE n=9);
SELECT is((public.admit_voice_pilot((SELECT b FROM buyers WHERE n=9),'public85-private-after-downgrade','private-after-downgrade','+15555559999','+15742638634',true)).id,NULL::uuid,'downgrade never revives private pilot');
SELECT throws_ok($$UPDATE public.voice_pilot_settings SET retired_at=NULL WHERE business_id=(SELECT b FROM buyers WHERE n=9)$$,
  '55000','voice pilot retirement is permanent','retirement cannot be rolled back by settings edit');
SELECT throws_ok($$DELETE FROM public.voice_pilot_settings WHERE business_id=(SELECT b FROM buyers WHERE n=9)$$,
  '55000','voice pilot retirement is permanent','deleting pilot settings cannot revive the exception');
-- Telecom deliberately retains its own tombstone and prevents hard deletion.
-- Clear only this transaction's empty synthetic release-run fixtures to exercise
-- the voice foreign-key behavior after the real billing scrub assertions.
CREATE FUNCTION pg_temp.clear_empty_telecom_fixture(b uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.telnyx_managed_resources WHERE business_id=b) THEN RAISE EXCEPTION 'fixture still owns telecom resources'; END IF;
  DELETE FROM public.telnyx_resource_release_events WHERE business_id=b;
  DELETE FROM public.telnyx_resource_release_actions WHERE business_id=b;
  DELETE FROM public.telnyx_resource_release_reasons WHERE business_id=b;
  UPDATE public.businesses SET active_telnyx_release_run_id=NULL WHERE id=b;
  DELETE FROM public.telnyx_resource_release_runs WHERE business_id=b;
END $$;
-- Finish the real retained-tombstone workflow before exercising hard-delete
-- foreign keys. These businesses have no live telecom resource fixtures.
CREATE FUNCTION pg_temp.complete_empty_cleanup(b uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE generation bigint;
BEGIN
  DELETE FROM public.subscriptions WHERE business_id=b;
  UPDATE public.telnyx_resource_release_runs SET status='released',completed_at=clock_timestamp()
    WHERE id=(SELECT active_telnyx_release_run_id FROM public.businesses WHERE id=b);
  SELECT a.generation INTO generation FROM public.account_deletion_stripe_actions a WHERE a.business_id=b;
  RETURN public.complete_expired_business_cleanup(b,generation);
END $$;
-- Permanent cleanup follows durable cancellation authority, then clears owner
-- links while keeping immutable non-content invoice deduplication evidence.
-- These synthetic numbers have no real provider resources; remove them before
-- exercising billing retention, so existing telecom-release guards stay intact.
DELETE FROM public.phone_numbers WHERE business_id IN(SELECT b FROM buyers WHERE n IN(4,5));
UPDATE public.businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=(SELECT b FROM buyers WHERE n=4);
SELECT public.queue_account_deletion_stripe_action(b,'sub_public854','cancel') FROM buyers WHERE n=4;
UPDATE public.account_deletion_stripe_actions SET applied_action='cancel',status='applied',applied_at=now() WHERE business_id=(SELECT b FROM buyers WHERE n=4);
UPDATE public.businesses SET owner_id=NULL WHERE id=(SELECT b FROM buyers WHERE n=4);
SELECT lives_ok($$UPDATE public.businesses SET cleanup_pii_scrubbed_at=clock_timestamp() WHERE id=(SELECT b FROM buyers WHERE n=4)$$,'verified cancellation permits paid voice account retention cleanup');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM buyers WHERE n=4)),1,'scrub retains cancellation authority until cleanup completes');
SELECT ok(pg_temp.complete_empty_cleanup((SELECT b FROM buyers WHERE n=4)),'actual cleanup completion purges resolved authority');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM buyers WHERE n=4)),0,'completed cleanup removes owner-linked billing operation details');
SELECT pg_temp.clear_empty_telecom_fixture(b) FROM buyers WHERE n=4;
SELECT lives_ok($$DELETE FROM public.businesses WHERE id=(SELECT b FROM buyers WHERE n=4)$$,'scrubbed account can be permanently deleted');
SELECT ok((SELECT business_id IS NULL AND invoice_id='in_public854' FROM public.voice_billing_payments WHERE invoice_id='in_public854'),'payment deduplication survives without an owner/business link');
SELECT is((SELECT count(*)::integer FROM public.voice_commercial_settings WHERE business_id=(SELECT b FROM buyers WHERE n=4)),0,'owner settings are removed on account cleanup');
UPDATE public.businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=(SELECT b FROM buyers WHERE n=5);
SELECT public.queue_account_deletion_stripe_action(b,'sub_public85replacement','cancel') FROM buyers WHERE n=5;
UPDATE public.account_deletion_stripe_actions SET applied_action='cancel',status='applied',applied_at=now() WHERE business_id=(SELECT b FROM buyers WHERE n=5);
UPDATE public.businesses SET owner_id=NULL WHERE id=(SELECT b FROM buyers WHERE n=5);
SELECT lives_ok($$UPDATE public.businesses SET cleanup_pii_scrubbed_at=clock_timestamp() WHERE id=(SELECT b FROM buyers WHERE n=5)$$,'rejoin cleanup uses immutable old-source terminal proof plus current cancellation authority');
SELECT ok(pg_temp.complete_empty_cleanup((SELECT b FROM buyers WHERE n=5)),'rejoin cleanup completes after verified current and historic cancellation');
SELECT pg_temp.clear_empty_telecom_fixture(b) FROM buyers WHERE n=5;
SELECT lives_ok($$DELETE FROM public.businesses WHERE id=(SELECT b FROM buyers WHERE n=5)$$,'historical replaced subscription does not strand deleted business');
SELECT is((SELECT count(*)::integer FROM public.voice_billing_payments WHERE invoice_id IN('in_public855','in_public85reupgrade','in_public85replacement') AND business_id IS NULL),3,'all three immutable invoice facts lose their business link after rejoin cleanup');
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_identity_hash=encode(extensions.digest('public85-spent','sha256'),'hex')),123::numeric,'cleanup cannot refund the original consumed allowance');
-- Retired pilot calls follow the normal retained-tombstone cleanup after
-- provider termination and accounting; history must not revive the exception.
DO $$ DECLARE v record; BEGIN
  FOR v IN SELECT * FROM public.voice_sessions WHERE business_id=(SELECT b FROM buyers WHERE n=9) AND access_source='commercial' AND response_mode='voice' LOOP
    PERFORM public.record_voice_customer_start(v.id,'retired-cleanup-start',v.created_at);
    PERFORM public.acknowledge_voice_customer_start(v.id,'retired-cleanup-start');
    PERFORM public.record_voice_customer_end(v.id,'retired-cleanup-end',clock_timestamp());
    PERFORM public.finalize_voice_session(v.id,'caller_hangup',NULL,false);
  END LOOP;
END $$;
DELETE FROM public.phone_numbers WHERE business_id=(SELECT b FROM buyers WHERE n=9);
UPDATE public.businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=(SELECT b FROM buyers WHERE n=9);
SELECT public.queue_account_deletion_stripe_action(b,'sub_public859','cancel') FROM buyers WHERE n=9;
UPDATE public.account_deletion_stripe_actions SET applied_action='cancel',status='applied',applied_at=now() WHERE business_id=(SELECT b FROM buyers WHERE n=9);
SELECT lives_ok($$SELECT public.cleanup_expired_business((SELECT b FROM buyers WHERE n=9))$$,'retired pilot follows the actual privacy scrub lifecycle');
SELECT ok(pg_temp.complete_empty_cleanup((SELECT b FROM buyers WHERE n=9)),'retired pilot completes the normal account cleanup lifecycle');
SELECT ok((SELECT owner_id IS NULL AND deletion_scheduled_for IS NULL AND cleanup_pii_scrubbed_at IS NOT NULL FROM public.businesses WHERE id=(SELECT b FROM buyers WHERE n=9)),'pilot retirement does not block completed account cleanup');
SELECT ok((SELECT retired_at IS NOT NULL AND retirement_operation_id IS NULL FROM public.voice_pilot_settings WHERE business_id=(SELECT b FROM buyers WHERE n=9)),'scrubbed tombstone retains permanent retirement without owner-linked operation');
SELECT * FROM finish();
ROLLBACK;
