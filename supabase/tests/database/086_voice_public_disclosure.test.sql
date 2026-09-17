BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE TEMP TABLE disclosure_fixture(b uuid,o uuid,p uuid);
DO $$ DECLARE b uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); BEGIN
  INSERT INTO auth.users(id,email) VALUES(o,'public-disclosure@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(b,o,'Notice business','general','public-disclosure');
  INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES(b,'+15555558086','notice-number',true);
  INSERT INTO public.voice_allowance_periods(id,business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
    VALUES(p,b,'notice-subscription',now()-interval '1 day',now()+interval '29 days',6000,now()-interval '1 day');
  INSERT INTO disclosure_fixture VALUES(b,o,p);
END $$;
CREATE FUNCTION pg_temp.disclosure_call(label text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); f record;
BEGIN
  SELECT * INTO f FROM disclosure_fixture;
  INSERT INTO public.contacts(id,business_id,phone_number,source_channel) VALUES(c,f.b,'+1555555'||lpad((1000+(SELECT count(*) FROM public.voice_sessions WHERE business_id=f.b))::text,4,'0'),'voice');
  INSERT INTO public.conversations(id,business_id,contact_id,channel,is_ai_handling) VALUES(v,f.b,c,'voice',false);
  INSERT INTO public.voice_sessions(id,business_id,conversation_id,action_business_id,action_conversation_id,call_control_id,call_session_id,caller_phone,called_phone,
    response_mode,status,reserved_seconds,access_source,allowance_period_id,commercial_deadline_at)
    VALUES(s,f.b,v,f.b,v,'notice-'||label,'notice-session-'||label,'+15555551000','+15555558086','voice','notice',600,'commercial',f.p,clock_timestamp()+interval '12 minutes');
  INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds)
    VALUES(s,encode(extensions.digest('notice-'||label,'sha256'),'hex'),f.b,s,f.p,600);
  INSERT INTO public.voice_stream_credentials(session_id,token_hash,expires_at) VALUES(s,encode(extensions.digest('token-'||label,'sha256'),'hex'),clock_timestamp()+interval '2 minutes');
  RETURN s;
END $$;
CREATE TEMP TABLE disclosure_calls(n integer,id uuid);
INSERT INTO disclosure_calls VALUES(1,pg_temp.disclosure_call('one'));
SELECT is((SELECT disclosure_version FROM public.voice_sessions WHERE id=(SELECT id FROM disclosure_calls WHERE n=1)),1,'new call requires the public disclosure protocol');
SELECT ok(NOT public.activate_voice_session((SELECT id FROM disclosure_calls WHERE n=1),'provider-one'),'generic activation cannot bypass disclosure');
SELECT ok(NOT public.begin_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'provider-one'),'provider cannot start before token consumption');
SELECT ok(NOT public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'notice-1-one'),'notice cannot complete before authenticated media startup');
SELECT ok(NOT public.mark_voice_recording_started((SELECT id FROM disclosure_calls WHERE n=1)),'recording cannot start before notice playback');
SELECT throws_ok($$SELECT public.record_voice_fragment((SELECT id FROM disclosure_calls WHERE n=1),'early','customer','private opening',0,20)$$,
 'P0001','voice conversation not activated','pre-notice input cannot be persisted through the RPC');
SELECT is((public.consume_voice_stream(encode(extensions.digest('token-one','sha256'),'hex'))).id,(SELECT id FROM disclosure_calls WHERE n=1),'notice-only authenticated stream may attach without recording');
SELECT ok((public.consume_voice_stream(encode(extensions.digest('token-one','sha256'),'hex'))).id IS NULL,'notice token is still single-use');
SELECT ok(public.begin_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'provider-one'),'registers the one notice provider session');
SELECT ok(NOT public.begin_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'other-provider'),'provider identity cannot be replaced');
SELECT ok(NOT public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'arbitrary'),'non-notice mark cannot complete opening');
SELECT ok(public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'notice-1-one'),'verified worker notice mark completes disclosure');
SELECT ok(public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'notice-1-one'),'same notice acknowledgment is idempotent');
SELECT ok(NOT public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=1),'notice-1-other'),'different acknowledgment cannot replace notice evidence');
SELECT ok(NOT public.voice_action_allowed((SELECT id FROM disclosure_calls WHERE n=1),'contact'),'heard notice alone cannot authorize actions');
SELECT throws_ok($$SELECT public.record_voice_customer_start((SELECT id FROM disclosure_calls WHERE n=1),'old-first-audio',clock_timestamp())$$,
 'P0001','voice handoff required','first notice audio cannot start customer billing');
SELECT ok(public.mark_voice_recording_started((SELECT id FROM disclosure_calls WHERE n=1)),'provider recording success is separately stored');
SELECT ok(public.begin_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=1),'handoff-one',clock_timestamp()),'candidate handoff starts after notice and recording');
SELECT ok(NOT public.acknowledge_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=1),'handoff-other',800),'wrong handoff mark does not activate');
SELECT throws_ok($$SELECT public.acknowledge_voice_customer_start((SELECT id FROM disclosure_calls WHERE n=1),'handoff-one')$$,
 'P0001','voice handoff acknowledgment required','generic acknowledgment cannot bypass handoff activation');
SELECT ok(public.acknowledge_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=1),'handoff-one',800),'correct handoff acknowledges time and activates atomically');
SELECT ok(public.voice_action_allowed((SELECT id FROM disclosure_calls WHERE n=1),'contact'),'actions become available after handoff');
SELECT ok((SELECT started_at>=notice_completed_at AND started_at>=recording_started_at FROM public.voice_sessions WHERE id=(SELECT id FROM disclosure_calls WHERE n=1)),
 'customer clock excludes notice and recording startup');
SELECT throws_ok($$SELECT public.record_voice_fragment((SELECT id FROM disclosure_calls WHERE n=1),'late-early','customer','late private opening',100,200)$$,
 'P0001','voice conversation not activated','late pre-handoff fragment cannot enter history');
SELECT lives_ok($$SELECT public.record_voice_fragment((SELECT id FROM disclosure_calls WHERE n=1),'normal','customer','hours please',800,900)$$,'post-handoff conversation may be saved');
SELECT public.record_voice_customer_end(call_key,'end-one',started_at+interval '2 seconds') FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=1);
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=1)),2::numeric,'only acknowledged conversation time is settled');
SELECT ok(NOT public.acknowledge_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=1),'handoff-one',800),'ended call cannot be reactivated');

INSERT INTO disclosure_calls VALUES(2,pg_temp.disclosure_call('refused'));
SELECT public.finalize_voice_session((SELECT id FROM disclosure_calls WHERE n=2),'recording_declined',NULL,true);
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=2)),NULL::numeric,'closing or refusal alone does not release a possibly live call');
SELECT public.record_voice_customer_termination((SELECT id FROM disclosure_calls WHERE n=2),'verified-ended',clock_timestamp());
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=2)),0::numeric,'verified disclosure-only termination settles zero immediately');
SELECT is((SELECT adjustment_reason FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=2)),'disclosure_only_no_customer_usage','zero usage has an explicit proof reason');
SELECT public.record_voice_customer_end((SELECT id FROM disclosure_calls WHERE n=2),'late-end',clock_timestamp());
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=2)),0::numeric,'late provider evidence cannot increase a zero-use deduction');
SELECT is((SELECT count(*)::integer FROM public.voice_transcript_fragments WHERE session_id=(SELECT id FROM disclosure_calls WHERE n=2)),0,'refused opening retains no caller content');

INSERT INTO disclosure_calls VALUES(3,pg_temp.disclosure_call('unknown-end'));
SELECT public.consume_voice_stream(encode(extensions.digest('token-unknown-end','sha256'),'hex'));
SELECT public.begin_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=3),'provider-three');
SELECT public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=3),'notice-1-three');
SELECT public.mark_voice_recording_started((SELECT id FROM disclosure_calls WHERE n=3));
SELECT public.begin_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=3),'handoff-three',clock_timestamp());
SELECT public.acknowledge_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=3),'handoff-three',1000);
SELECT public.record_voice_customer_termination((SELECT id FROM disclosure_calls WHERE n=3),'verified-unknown-end',clock_timestamp());
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=3)),NULL::numeric,'active call with uncertain end retains the existing24-hour hold');
SELECT is((SELECT state FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=3)),'reconciling','active uncertain time remains in reconciliation');
SELECT ok(NOT has_function_privilege('authenticated','public.complete_voice_disclosure(uuid,text)','EXECUTE'),'owners cannot claim played notice');
SELECT ok(NOT has_function_privilege('anon','public.acknowledge_voice_conversation_handoff(uuid,text,numeric)','EXECUTE'),'anonymous callers cannot activate or bill calls');

-- Phone termination does not by itself close the worker lifecycle. Complete
-- both earlier fixture workers before exercising the shared admission cap.
SELECT public.finalize_voice_session(id,'caller_hangup',NULL,false) FROM disclosure_calls WHERE n IN (1,3);

-- A single service-armed rehearsal exercises this same phone protocol on the
-- approved pilot, without paid enrollment, any public rollout, or customer use.
DO $$ DECLARE o uuid:=gen_random_uuid(); b uuid:='ea848911-ef72-44a6-8cf3-c47b3959be26'; BEGIN
  INSERT INTO auth.users(id,email) VALUES(o,'disclosure-rehearsal@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(b,o,'Rehearsal','general','disclosure-rehearsal');
  INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES(b,'+15742638634','rehearsal-number',true);
  INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES(b,'cus_rehearsal','sub_rehearsal','sms_and_chat','active');
  INSERT INTO public.voice_pilot_settings(business_id,enabled) VALUES(b,true);
  INSERT INTO public.voice_pilot_testers(business_id,phone_number,prior_disclosure_acknowledged_at) VALUES(b,'+15555558886',now()-interval '1 day');
END $$;
SELECT ok(NOT has_function_privilege('authenticated','public.arm_voice_public_opening_rehearsal(text,uuid)','EXECUTE'),'owner cannot arm the protected rehearsal');
SELECT ok(NOT public.arm_voice_public_opening_rehearsal('+15555558886',NULL),'rehearsal requires an admin identity');
SELECT ok(NOT public.arm_voice_public_opening_rehearsal('+15555550000',(SELECT o FROM disclosure_fixture)),'unapproved caller cannot be armed');
SELECT ok(public.arm_voice_public_opening_rehearsal('+15555558886',(SELECT o FROM disclosure_fixture)),'approved pilot tester can be armed without a commercial grant');
INSERT INTO disclosure_calls SELECT 4,(public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','rehearsal-one','rehearsal-session','+15555558886','+15742638634',true)).id;
SELECT ok((SELECT public_notice_rehearsal AND disclosure_version=1 AND access_source='pilot' AND prior_disclosure_acknowledged_at IS NULL FROM public.voice_sessions WHERE id=(SELECT id FROM disclosure_calls WHERE n=4)),
 'one admitted pilot call uses the public opening and cannot skip it with prior acknowledgment');
SELECT is((SELECT public_notice_rehearsal_until FROM public.voice_pilot_testers WHERE phone_number='+15555558886'),NULL::timestamptz,'one-call arm is consumed atomically');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=4)),0,'rehearsal creates no customer minute ledger');
SELECT is((public.prepare_preinformed_voice_session((SELECT id FROM disclosure_calls WHERE n=4))).id,NULL::uuid,'rehearsal cannot use the private prior-acknowledgment skip');
SELECT is((public.claim_voice_preparation((SELECT id FROM disclosure_calls WHERE n=4))).id,NULL::uuid,'rehearsal cannot claim the private preparation path');
UPDATE public.voice_sessions SET status='notice' WHERE id=(SELECT id FROM disclosure_calls WHERE n=4);
INSERT INTO public.voice_stream_credentials(session_id,token_hash,expires_at) SELECT id,encode(extensions.digest('rehearsal-token','sha256'),'hex'),clock_timestamp()+interval '2 minutes' FROM disclosure_calls WHERE n=4;
SELECT is((public.consume_voice_stream(encode(extensions.digest('rehearsal-token','sha256'),'hex'))).id,(SELECT id FROM disclosure_calls WHERE n=4),'rehearsal authenticates in notice phase');
SELECT ok(NOT public.activate_voice_session((SELECT id FROM disclosure_calls WHERE n=4),'rehearsal-provider'),'generic pilot activation cannot bypass rehearsal notice');
SELECT ok(public.begin_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=4),'rehearsal-provider'),'rehearsal starts the notice provider');
SELECT ok(public.complete_voice_disclosure((SELECT id FROM disclosure_calls WHERE n=4),'notice-1-rehearsal'),'rehearsal requires its complete phone playback mark');
SELECT ok(public.mark_voice_recording_started((SELECT id FROM disclosure_calls WHERE n=4)),'rehearsal begins recording only after notice');
SELECT ok(public.begin_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=4),'handoff-rehearsal',clock_timestamp()),'rehearsal nominates a handoff without commercial usage');
SELECT ok(public.acknowledge_voice_conversation_handoff((SELECT id FROM disclosure_calls WHERE n=4),'handoff-rehearsal',2000),'rehearsal activates only after handoff acknowledgment');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE call_key=(SELECT id FROM disclosure_calls WHERE n=4)),0,'activated rehearsal still uses only existing pilot budget');
SELECT ok(NOT public.arm_voice_public_opening_rehearsal('+15555558886',(SELECT o FROM disclosure_fixture)),'cannot arm another rehearsal while the pilot call is active');
SELECT public.finalize_voice_session((SELECT id FROM disclosure_calls WHERE n=4),'caller_hangup',NULL,false);
UPDATE public.voice_sessions SET phone_ended_at=clock_timestamp() WHERE id=(SELECT id FROM disclosure_calls WHERE n=4);
INSERT INTO disclosure_calls SELECT 5,(public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','rehearsal-next','rehearsal-next-session','+15555558886','+15742638634',true)).id;
SELECT ok((SELECT NOT public_notice_rehearsal AND access_source='pilot' FROM public.voice_sessions WHERE id=(SELECT id FROM disclosure_calls WHERE n=5)),'next ordinary approved call keeps the private baseline');
SELECT public.finalize_voice_session((SELECT id FROM disclosure_calls WHERE n=5),'caller_hangup',NULL,false);
UPDATE public.voice_sessions SET phone_ended_at=clock_timestamp() WHERE id=(SELECT id FROM disclosure_calls WHERE n=5);
SELECT ok(public.arm_voice_public_opening_rehearsal('+15555558886',(SELECT o FROM disclosure_fixture)),'may rearm explicitly for another approved acceptance attempt');
UPDATE public.voice_pilot_testers SET public_notice_rehearsal_until=clock_timestamp()-interval '1 second' WHERE phone_number='+15555558886';
INSERT INTO disclosure_calls SELECT 6,(public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','rehearsal-expired','rehearsal-expired-session','+15555558886','+15742638634',true)).id;
SELECT ok((SELECT NOT public_notice_rehearsal FROM public.voice_sessions WHERE id=(SELECT id FROM disclosure_calls WHERE n=6)),'expired arm cannot alter a later private call');

-- The provider-cost estimate keeps legacy Polly rates, and prices public media
-- and recording from their actual separate start boundaries with no Polly TTS.
UPDATE public.voice_sessions SET created_at=clock_timestamp()-interval '60 seconds',
  media_start_requested_at=clock_timestamp()-interval '50 seconds',recording_started_at=clock_timestamp()-interval '40 seconds',phone_ended_at=clock_timestamp()
  WHERE id=(SELECT id FROM disclosure_calls WHERE n=4);
SELECT public.estimate_voice_telnyx_usage(100);
SELECT ok(abs((SELECT estimated_cost_usd FROM public.voice_provider_usage WHERE session_id=(SELECT id FROM disclosure_calls WHERE n=4) AND provider='telnyx')-(0.0052+50.0/60*0.0035+40.0/60*0.002))<0.00001,
 'same-Marin rehearsal has no Telnyx TTS estimate and recording starts after its notice');
SELECT * FROM finish();
ROLLBACK;
