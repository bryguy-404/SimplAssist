BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
-- This suite exercises retained protocol-0 calls. New disclosure behavior is
-- covered separately; the default change is transaction-local and rolls back.
ALTER TABLE public.voice_sessions ALTER COLUMN disclosure_version SET DEFAULT 0;
CREATE TEMP TABLE fixture(n integer PRIMARY KEY,b uuid,o uuid);
CREATE FUNCTION pg_temp.customer(n integer,initial_plan text DEFAULT 'full') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); rev bigint; operation uuid;
BEGIN
  INSERT INTO auth.users(id,email) VALUES(o,'voice-monthly-'||n||'@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(b,o,'Monthly voice','general','voice-monthly-'||n);
  INSERT INTO public.voice_rollout_businesses(business_id,enabled) VALUES(b,true);
  INSERT INTO public.voice_commercial_settings(business_id) VALUES(b);
  INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES(b,'+15555550'||lpad(n::text,3,'0'),'monthly-number-'||n,true);
  INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
    VALUES(b,'cus_monthly_'||n,'sub_monthly_'||n,initial_plan,'active',now()-interval '10 days',now()+interval '20 days');
  rev:=public.begin_voice_billing_reconciliation(b,'sub_monthly_'||n,'cus_monthly_'||n);
  INSERT INTO public.sms_billing_operations(business_id,owner_id,kind,state,target_plan,target_price_id,stripe_subscription_id,stripe_customer_id,
    source_fingerprint,expires_at,confirmed_at,applied_at,invoice_id,payment_effective_at,payment_verified_at)
    VALUES(b,o,'checkout','applied','full','price_fixture','sub_monthly_'||n,'cus_monthly_'||n,repeat('a',64),now()+interval '1 day',now(),now(),
      'in_monthly_'||n,now()-interval '10 days',now()) RETURNING id INTO operation;
  UPDATE public.voice_billing_projection SET entitlement_operation_id=operation WHERE business_id=b;
  PERFORM public.record_voice_billing_payment(b,rev,'sub_monthly_'||n,'cus_monthly_'||n,'in_monthly_'||n,now()-interval '10 days',now()+interval '20 days',now()-interval '10 days');
  UPDATE public.subscriptions SET plan='full' WHERE business_id=b;
  PERFORM public.apply_voice_billing_projection(b,rev,'sub_monthly_'||n,'full','active',now()-interval '10 days',now()+interval '20 days',false,
    CASE WHEN initial_plan='full' THEN now()-interval '10 days' ELSE now() END);
  INSERT INTO fixture VALUES(n,b,o);
  RETURN b;
END $$;
SELECT pg_temp.customer(n) FROM generate_series(1,4) n;

SELECT ok(NOT (SELECT enabled FROM public.voice_rollout_control),'commercial rollout defaults off');
SELECT is((public.get_voice_commercial_summary((SELECT b FROM fixture WHERE n=1))->>'reason'),'rollout_closed','full plan alone cannot enable rollout');
SELECT ok(NOT has_table_privilege('authenticated','public.voice_commercial_settings','UPDATE'),'owners cannot bypass settings RPC');
SELECT ok(NOT has_function_privilege('authenticated','public.admit_voice_commercial(uuid,text,text,text,text,boolean)','EXECUTE'),'owners cannot admit calls');
SELECT ok(NOT has_function_privilege('anon','public.record_voice_customer_end(uuid,text,timestamptz)','EXECUTE'),'anonymous cannot bill minutes');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=1)),6000,'approved full cycle receives exactly 100 minutes');
SELECT throws_ok($$SELECT public.configure_voice_commercial((SELECT b FROM fixture WHERE n=1),'voice',true,1,(SELECT o FROM fixture WHERE n=2))$$,'42501','voice owner access denied','another owner cannot configure business');
SELECT throws_ok($$SELECT public.configure_voice_commercial((SELECT b FROM fixture WHERE n=1),'voice',true,1,(SELECT o FROM fixture WHERE n=1))$$,'42501','voice access unavailable: rollout_closed','closed rollout rejects owner activation');
UPDATE public.voice_rollout_control SET enabled=true;
SELECT public.configure_voice_commercial(b,'voice',true,1,o) FROM fixture;
SELECT throws_ok($$SELECT public.configure_voice_commercial((SELECT b FROM fixture WHERE n=1),'text',true,1,(SELECT o FROM fixture WHERE n=1))$$,'40001','voice settings changed; reload','concurrent edits require current revision');
CREATE TEMP TABLE calls(n integer PRIMARY KEY,id uuid);
INSERT INTO calls SELECT 1,(public.admit_voice_commercial(b,'monthly-1','monthly-session-1','+15555559999','+15555550001',true)).id FROM fixture WHERE n=1;
SELECT is((SELECT access_source FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=1)),'commercial','call records access source');
SELECT is((SELECT reserved_seconds FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=1)),600,'call atomically reserves ten minutes');
SELECT is((public.get_voice_commercial_summary((SELECT b FROM fixture WHERE n=1))->>'held_seconds')::numeric,600::numeric,'active reservation is visible separately');
SELECT is((public.admit_voice_commercial((SELECT b FROM fixture WHERE n=1),'monthly-1','monthly-session-1','+15555559999','+15555550001',true)).id,(SELECT id FROM calls WHERE n=1),'duplicate call reuses frozen decision');
SELECT throws_ok($$SELECT public.admit_voice_commercial((SELECT b FROM fixture WHERE n=2),'monthly-1','monthly-session-1','+15555559999','+15555550002',true)$$,'P0001','Call identity mismatch','cross-business callback cannot reuse grant');
SELECT throws_ok($$DELETE FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=1)$$,'55000','settle commercial voice before deleting its history','active call cannot lose its termination identity');

-- Grant continuation ignores ordinary configuration/billing changes, while
-- action-specific SMS permission remains independent and booking remains closed.
SELECT public.configure_voice_commercial(b,'text',false,2,o) FROM fixture WHERE n=1;
UPDATE public.subscriptions SET status='canceled' WHERE business_id=(SELECT b FROM fixture WHERE n=1);
SELECT ok(public.voice_session_continuation_allowed((SELECT id FROM calls WHERE n=1)),'admitted call drains after ordinary plan/preference loss');
UPDATE public.voice_sessions SET status='starting',notice_completed_at=now() WHERE id=(SELECT id FROM calls WHERE n=1);
SELECT ok(public.activate_voice_session((SELECT id FROM calls WHERE n=1),'commercial-openai'),'admitted call may activate after downgrade');
SELECT ok(public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'contact'),'contact saving remains available during bounded drain');
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'signup'),'canceled SMS entitlement blocks signup send');
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM calls WHERE n=1),'booking'),'booking is still disabled');
SELECT public.record_voice_fragment((SELECT id FROM calls WHERE n=1),'contact-request','customer','My name is Alex and my email is alex@example.test.',100,200);
CREATE TEMP TABLE contact_action AS SELECT (public.propose_voice_action((SELECT id FROM calls WHERE n=1),'contact',repeat('a',64),
  '{"name":"Alex","email":"alex@example.test"}'::jsonb,'May I save Alex and alex@example.test?',ARRAY['contact-request'])).id;
SELECT public.record_voice_fragment((SELECT id FROM calls WHERE n=1),'contact-readback','assistant','May I save Alex and alex@example.test?',300,400);
SELECT ok(public.mark_voice_action_playback((SELECT id FROM calls WHERE n=1),(SELECT id FROM contact_action),'contact-readback',200),'commercial readback uses the existing playback guard');
SELECT public.record_voice_fragment((SELECT id FROM calls WHERE n=1),'contact-confirmation','customer','Yes, please.',500,600);
-- Production fragments arrive in separate transactions; this test transaction
-- gives the confirmation its actual later receipt time explicitly.
UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp() WHERE session_id=(SELECT id FROM calls WHERE n=1) AND event_id='contact-confirmation';
SELECT is((public.claim_voice_action((SELECT id FROM calls WHERE n=1),(SELECT id FROM contact_action),ARRAY['contact-readback'],ARRAY['contact-confirmation'])).status,
  'executing','existing proposal and claim RPCs resolve commercial continuation policy');
SELECT ok(public.voice_action_execution_current((SELECT id FROM contact_action)),'SQL execution guard resolves commercial action policy');
UPDATE public.voice_rollout_control SET emergency_stop=true;
SELECT ok(NOT public.voice_session_continuation_allowed((SELECT id FROM calls WHERE n=1)),'emergency stop revokes active grants');
UPDATE public.voice_rollout_control SET emergency_stop=false;
UPDATE public.businesses SET operations_suspended_at=now() WHERE id=(SELECT b FROM fixture WHERE n=1);
SELECT ok(NOT public.voice_session_continuation_allowed((SELECT id FROM calls WHERE n=1)),'suspended business loses active grant');
UPDATE public.businesses SET operations_suspended_at=NULL WHERE id=(SELECT b FROM fixture WHERE n=1);

INSERT INTO calls SELECT 102,(public.admit_voice_commercial(b,'monthly-capacity-second','monthly-capacity-second','+15555559999','+15555550002',true)).id FROM fixture WHERE n=2;
INSERT INTO calls SELECT 103,(public.admit_voice_commercial(b,'monthly-capacity-third','monthly-capacity-third','+15555559999','+15555550003',true)).id FROM fixture WHERE n=3;
SELECT is((SELECT response_mode FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=102)),'voice','second independent business can use remaining worker capacity');
SELECT is((SELECT outcome FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=103)),'capacity_unavailable','global capacity applies across independent business pools');
SELECT public.record_voice_customer_start(call_key,'capacity-first-audible',created_at) FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=102);
SELECT public.acknowledge_voice_customer_start((SELECT id FROM calls WHERE n=102),'capacity-first-audible');
SELECT public.record_voice_customer_end((SELECT id FROM calls WHERE n=102),'capacity-proven-end',clock_timestamp());
SELECT public.finalize_voice_session((SELECT id FROM calls WHERE n=102),'caller_hangup',NULL,false);

SELECT public.record_voice_customer_start(call_key,'audible-first',created_at+interval '1 second') FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1);
SELECT public.update_voice_usage((SELECT id FROM calls WHERE n=1),250,true);
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)),NULL::numeric,'provider seconds do not consume customer minutes');
SELECT public.record_voice_customer_end(call_key,'hangup-original',created_at+interval '3 seconds') FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1);
SELECT is((SELECT state FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)),'reconciling','unacknowledged first audio cannot be charged');
SELECT throws_ok($$DELETE FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=1)$$,'55000','settle commercial voice before deleting its history','terminated but unsettled call retains reconciliation identity');
SELECT throws_ok($$SELECT public.acknowledge_voice_customer_start((SELECT id FROM calls WHERE n=1),'wrong-mark')$$,'P0001','customer start acknowledgment mismatch','wrong playback mark cannot validate start');
SELECT public.acknowledge_voice_customer_start((SELECT id FROM calls WHERE n=1),'audible-first');
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)),2::numeric,'only verified conversation seconds are counted');
SELECT public.record_voice_customer_end(call_key,'late-contradictory',created_at+interval '4 seconds') FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1);
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)),2::numeric,'late end retry cannot increase settled charge');
SELECT public.finalize_voice_session((SELECT id FROM calls WHERE n=1),'caller_hangup',NULL,false);
SELECT public.update_voice_usage((SELECT id FROM calls WHERE n=1),280,true);
SELECT is((SELECT used_seconds FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=1)),280::numeric,'provider reconciliation stays independent');
SELECT is((public.get_voice_commercial_summary((SELECT b FROM fixture WHERE n=1))->>'held_seconds')::numeric,0::numeric,'settlement releases unused hold');
SELECT is((public.get_voice_commercial_summary((SELECT b FROM fixture WHERE n=1))->>'used_seconds')::numeric,2::numeric,'dashboard shows customer seconds');
DELETE FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=1);
SELECT is((SELECT session_id FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)),NULL::uuid,'history deletion clears history reference');
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)),2::numeric,'history deletion never refunds usage');
SELECT throws_ok($$SELECT public.admit_voice_commercial((SELECT b FROM fixture WHERE n=1),'monthly-1','monthly-session-1','+15555559999','+15555550001',true)$$,'55000','voice call history was deleted; replay denied','deleted call identity cannot get a new allowance');
SELECT throws_ok($$DELETE FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=1)$$,'55000','voice accounting cannot be deleted','ledger deletion cannot refund usage');
SELECT lives_ok($$UPDATE public.voice_allowance_periods SET included_seconds=6000 WHERE business_id=(SELECT b FROM fixture WHERE n=1) AND included_seconds<>6000$$,'no-op grant update is harmless');

-- Freshness: newer reconciliation blocks old writes before subscription sync.
CREATE TEMP TABLE tickets(rev bigint);
INSERT INTO tickets SELECT public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=2),'sub_monthly_2','cus_monthly_2');
INSERT INTO tickets SELECT public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=2),'sub_monthly_2','cus_monthly_2');
SELECT is(public.voice_commercial_access_reason((SELECT b FROM fixture WHERE n=2)),'billing_pending','pending fresh retrieval denies new calls');
SELECT ok(NOT public.sync_voice_stripe_subscription((SELECT b FROM fixture WHERE n=2),'cus_monthly_2','sub_monthly_2','sms_only','canceled',
  now()-interval '10 days',now()+interval '20 days',NULL,NULL,NULL,NULL,false,now(),(SELECT min(rev) FROM tickets),now()),'older ticket cannot overwrite subscription');
SELECT is((SELECT status FROM public.subscriptions WHERE business_id=(SELECT b FROM fixture WHERE n=2)),'active','stale projection did not write legacy subscription');
SELECT ok(public.apply_voice_billing_projection((SELECT b FROM fixture WHERE n=2),(SELECT max(rev) FROM tickets),'sub_monthly_2','full','active',
  now()-interval '10 days',now()+interval '20 days',false,now()),'newest authoritative ticket applies');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=2)),1,'refresh never grants twice');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=2)),6000,'refresh cannot rewrite initial allowance');
UPDATE public.subscriptions SET status='past_due' WHERE business_id=(SELECT b FROM fixture WHERE n=2);
SELECT is(public.voice_commercial_access_reason((SELECT b FROM fixture WHERE n=2)),'billing_pending','stale projection mismatch fails closed');
SELECT public.apply_voice_billing_projection((SELECT b FROM fixture WHERE n=2),public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=2),'sub_monthly_2','cus_monthly_2'),
 'sub_monthly_2','full','past_due',now()-interval '10 days',now()+interval '20 days',false,now());
SELECT is(public.voice_commercial_access_reason((SELECT b FROM fixture WHERE n=2)),'payment_required','past-due cannot start commercial voice');

-- A missing end timestamp holds quota until proven termination plus 24 hours.
INSERT INTO calls SELECT 3,(public.admit_voice_commercial(b,'monthly-3','monthly-session-3','+15555559999','+15555550003',true)).id FROM fixture WHERE n=3;
SELECT public.finalize_voice_session((SELECT id FROM calls WHERE n=3),'worker_lost',NULL,false);
SELECT public.reconcile_voice_customer_usage();
SELECT is((SELECT state FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=3)),'reserved','worker loss alone never releases possibly live call');
SELECT public.record_voice_customer_termination((SELECT id FROM calls WHERE n=3),'verified-status-ended',clock_timestamp());
SELECT ok((SELECT provider_hangup_confirmed_at IS NOT NULL AND phone_ended_at IS NULL FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=3)),
 'verified termination stops repeated hangup recovery without inventing an end timestamp');
SELECT public.reconcile_voice_customer_usage();
SELECT is((SELECT state FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=3)),'reconciling','termination starts bounded evidence recovery');
UPDATE public.voice_customer_usage SET reconcile_after=clock_timestamp()-interval '1 second' WHERE call_key=(SELECT id FROM calls WHERE n=3);
SELECT public.reconcile_voice_customer_usage();
SELECT is((SELECT state FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=3)),'adjusted','24-hour missing evidence receives audited adjustment');
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=3)),0::numeric,'unproven customer seconds are waived');
SELECT is((SELECT count(*)::integer FROM public.voice_commercial_audit WHERE kind='usage_adjustment'),1,'waiver has one audit entry');
SELECT public.reconcile_voice_customer_usage();
SELECT is((SELECT count(*)::integer FROM public.voice_commercial_audit WHERE kind='usage_adjustment'),1,'recovery retry does not duplicate adjustment');

SELECT pg_temp.customer(5,'sms_only');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=5)),4000,'mid-cycle upgrade prorates the 20 remaining days once');
SELECT is(public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=5),'sub_imposter','cus_monthly_5'),-1::bigint,'different subscription cannot acquire reconciliation authority');
SELECT is(public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=5),'sub_monthly_5','cus_imposter'),-1::bigint,'different customer cannot acquire reconciliation authority');
SELECT public.apply_voice_billing_projection((SELECT b FROM fixture WHERE n=5),public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=5),'sub_monthly_5','cus_monthly_5'),
 'sub_monthly_5','full','active',now()-interval '10 days',now()+interval '20 days',false,now()+interval '1 second');
SELECT is((SELECT included_seconds FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=5)),4000,'repeat full snapshot never replenishes prorated allowance');
SELECT throws_ok($$UPDATE public.voice_allowance_periods SET included_seconds=6000 WHERE business_id=(SELECT b FROM fixture WHERE n=5)$$,'55000','voice allowance grant is immutable','admin cannot rewrite existing cycle grant');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=5)),1,'canonical account retains only one grant for the cycle');
UPDATE public.subscriptions SET current_period_start=NULL,current_period_end=NULL WHERE business_id=(SELECT b FROM fixture WHERE n=5);
SELECT public.apply_voice_billing_projection((SELECT b FROM fixture WHERE n=5),public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=5),'sub_monthly_5','cus_monthly_5'),
 'sub_monthly_5','full','active',NULL,NULL,false,now());
SELECT is(public.voice_commercial_access_reason((SELECT b FROM fixture WHERE n=5)),'billing_pending','missing source period fails closed');
SELECT is((SELECT period_start FROM public.voice_billing_projection WHERE business_id=(SELECT b FROM fixture WHERE n=5)),now()-interval '10 days','malformed snapshot cannot erase verified period boundary');
UPDATE public.subscriptions SET current_period_start=now()-interval '1 day',current_period_end=now()+interval '29 days' WHERE business_id=(SELECT b FROM fixture WHERE n=5);
SELECT public.begin_voice_billing_reconciliation((SELECT b FROM fixture WHERE n=5),'sub_monthly_5','cus_monthly_5');
SELECT throws_ok($$SELECT public.apply_voice_billing_projection((SELECT b FROM fixture WHERE n=5),(SELECT requested_revision FROM public.voice_billing_projection WHERE business_id=(SELECT b FROM fixture WHERE n=5)),
 'sub_monthly_5','full','active',now()-interval '1 day',now()+interval '29 days',false,now())$$,'23514','voice billing periods overlap','missing-period snapshot cannot enable an overlapping allowance');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture WHERE n=5)),1,'malformed and overlapping snapshots still leave one grant');

-- Closing rollout keeps the already selected no-text fallback decision.
SELECT public.configure_voice_commercial(b,'voice',true,2,o) FROM fixture WHERE n=4;
UPDATE public.voice_rollout_control SET enabled=false;
SELECT lives_ok($$SELECT public.configure_voice_commercial(b,'voice',false,3,o) FROM fixture WHERE n=4$$,'existing voice preference may disable fallback even when rollout closes');
INSERT INTO calls SELECT 4,(public.admit_voice_commercial(b,'monthly-4','monthly-session-4','+15555559999','+15555550004',true)).id FROM fixture WHERE n=4;
SELECT is((SELECT response_mode FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=4)),'text','rollout stop freezes denial for existing voice preference');
SELECT ok(NOT (SELECT text_fallback_enabled FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=4)),'rollout stop preserves no-text fallback preference');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM calls WHERE n=4)),0,'denied calls never reserve minutes');
SELECT public.finalize_voice_session((SELECT id FROM calls WHERE n=4),'technical_failure',NULL,true);
SELECT ok(NOT (SELECT fallback_pending FROM public.voice_sessions WHERE id=(SELECT id FROM calls WHERE n=4)),'finalizer cannot override frozen no-text fallback');

-- RLS history remains scoped to the present owner after access loss.
GRANT SELECT ON fixture TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',(SELECT o FROM fixture WHERE n=2),'role','authenticated')::text,true);
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE business_id=(SELECT b FROM fixture WHERE n=1)),0,'other business owner cannot read metering history');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',(SELECT o FROM fixture WHERE n=1),'role','authenticated')::text,true);
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage),1,'former paid-voice owner can still read their settled usage');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
