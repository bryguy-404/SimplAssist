BEGIN;

CREATE FUNCTION public.begin_voice_billing_reconciliation(p_business_id uuid,p_subscription_id text,p_customer_id text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rev bigint; sub public.subscriptions; projection public.voice_billing_projection;
BEGIN
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p_business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' OR NOT (
    EXISTS(SELECT 1 FROM public.voice_commercial_settings WHERE business_id=p_business_id)
    OR EXISTS(SELECT 1 FROM public.voice_rollout_businesses WHERE business_id=p_business_id)
    OR EXISTS(SELECT 1 FROM public.voice_billing_projection WHERE business_id=p_business_id)) THEN RETURN NULL; END IF;
  SELECT * INTO sub FROM public.subscriptions WHERE business_id=p_business_id;
  SELECT * INTO projection FROM public.voice_billing_projection WHERE business_id=p_business_id;
  IF NULLIF(p_subscription_id,'') IS NULL OR NULLIF(p_customer_id,'') IS NULL
    OR (sub.business_id IS NOT NULL AND (sub.stripe_subscription_id IS DISTINCT FROM p_subscription_id OR sub.stripe_customer_id IS DISTINCT FROM p_customer_id))
    OR (projection.subscription_id IS NOT NULL AND projection.subscription_id<>p_subscription_id) THEN RETURN -1; END IF;
  INSERT INTO public.voice_billing_projection(business_id,requested_revision,subscription_id,plan,status,period_start,period_end)
    VALUES(p_business_id,1,sub.stripe_subscription_id,sub.plan,sub.status,sub.current_period_start,sub.current_period_end)
    ON CONFLICT(business_id) DO UPDATE SET requested_revision=voice_billing_projection.requested_revision+1,requested_at=clock_timestamp()
    RETURNING requested_revision INTO rev;
  RETURN rev;
END $$;

CREATE FUNCTION public.apply_voice_billing_projection(p_business_id uuid,p_revision bigint,p_subscription_id text,p_plan text,p_status text,
  p_period_start timestamptz,p_period_end timestamptz,p_cancel_at_period_end boolean,p_effective_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old public.voice_billing_projection; effective timestamptz; amount integer;
BEGIN
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.billing_mode='stripe' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO old FROM public.voice_billing_projection WHERE business_id=p_business_id FOR UPDATE;
  IF old.business_id IS NULL OR p_revision IS DISTINCT FROM old.requested_revision OR p_revision<=old.applied_revision THEN RETURN false; END IF;
  IF old.subscription_id IS NOT NULL AND old.subscription_id IS DISTINCT FROM p_subscription_id THEN RETURN false; END IF;
  IF p_effective_at IS NULL OR p_effective_at>clock_timestamp()+interval '1 minute'
    OR (p_period_start IS NOT NULL AND p_period_end IS NOT NULL AND p_period_end<=p_period_start)
    OR NOT EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.business_id=p_business_id AND s.stripe_subscription_id=p_subscription_id
      AND s.plan=p_plan AND s.status=p_status AND s.current_period_start IS NOT DISTINCT FROM p_period_start
      AND s.current_period_end IS NOT DISTINCT FROM p_period_end AND s.cancel_at_period_end=COALESCE(p_cancel_at_period_end,false)) THEN
    RAISE EXCEPTION 'voice billing source mismatch' USING ERRCODE='23514';
  END IF;
  -- An authoritative retrieval may revoke access, but a period may never rewind.
  IF old.period_start IS NOT NULL AND p_period_start<old.period_start THEN RETURN false; END IF;
  IF old.period_start<p_period_start AND old.period_end>p_period_start THEN
    RAISE EXCEPTION 'voice billing periods overlap' USING ERRCODE='23514'; END IF;
  IF old.subscription_id=p_subscription_id AND old.period_start=p_period_start AND old.period_end IS DISTINCT FROM p_period_end THEN
    RAISE EXCEPTION 'voice billing period changed in place' USING ERRCODE='23514';
  END IF;
  UPDATE public.voice_billing_projection SET applied_revision=p_revision,subscription_id=p_subscription_id,plan=p_plan,status=p_status,
    -- Missing source dates revoke admission through the source comparison, but
    -- cannot erase the last verified boundary and permit an overlapping grant.
    period_start=CASE WHEN p_period_start IS NULL OR p_period_end IS NULL THEN old.period_start ELSE p_period_start END,
    period_end=CASE WHEN p_period_start IS NULL OR p_period_end IS NULL THEN old.period_end ELSE p_period_end END,
    cancel_at_period_end=COALESCE(p_cancel_at_period_end,false),
    effective_at=GREATEST(old.effective_at,p_effective_at),verified_at=clock_timestamp() WHERE business_id=p_business_id;
  IF p_plan='full' AND p_status='active' AND p_period_start<=now() AND p_period_end>now() THEN
    effective:=CASE WHEN old.plan='full' OR old.subscription_id IS NULL THEN p_period_start
      ELSE GREATEST(p_period_start,old.effective_at,p_effective_at) END;
    amount:=GREATEST(0,LEAST(6000,floor(6000*extract(epoch FROM (p_period_end-effective))/extract(epoch FROM (p_period_end-p_period_start)))::integer));
    INSERT INTO public.voice_allowance_periods(business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
      VALUES(p_business_id,p_subscription_id,p_period_start,p_period_end,amount,effective)
      ON CONFLICT(business_id,subscription_id,period_start) DO NOTHING;
  END IF;
  RETURN true;
END $$;

-- This decision excludes owner preference, transient worker capacity and balance.
CREATE FUNCTION public.voice_commercial_access_reason(p_business_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.voice_billing_projection;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL
    AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL) THEN RETURN 'temporarily_unavailable'; END IF;
  IF p_business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' OR NOT EXISTS(SELECT 1 FROM public.voice_rollout_control g
    JOIN public.voice_rollout_businesses r ON r.business_id=p_business_id WHERE g.singleton AND g.enabled AND NOT g.emergency_stop AND r.enabled AND NOT r.emergency_stop) THEN RETURN 'rollout_closed'; END IF;
  SELECT * INTO p FROM public.voice_billing_projection WHERE business_id=p_business_id;
  IF p.business_id IS NULL OR p.applied_revision<>p.requested_revision OR p.verified_at IS NULL THEN RETURN 'billing_pending'; END IF;
  IF p.plan IS DISTINCT FROM 'full' THEN RETURN 'plan_required'; END IF;
  IF p.status IS DISTINCT FROM 'active' THEN RETURN 'payment_required'; END IF;
  IF p.period_start IS NULL OR p.period_end IS NULL OR p.period_start>now() OR p.period_end<=now()
    OR NOT EXISTS(SELECT 1 FROM public.businesses b JOIN public.subscriptions s ON s.business_id=b.id WHERE b.id=p_business_id AND b.billing_mode='stripe'
      AND s.stripe_subscription_id=p.subscription_id AND s.plan=p.plan AND s.status=p.status
      AND s.current_period_start=p.period_start AND s.current_period_end=p.period_end)
    OR NOT EXISTS(SELECT 1 FROM public.voice_allowance_periods a WHERE a.business_id=p_business_id AND a.subscription_id=p.subscription_id
      AND a.period_start=p.period_start AND a.period_end=p.period_end) THEN RETURN 'billing_pending'; END IF;
  RETURN NULL;
END $$;

-- Freshness check, legacy subscription write and voice projection are one
-- transaction. A delayed retrieval cannot overwrite a newer applied snapshot.
CREATE FUNCTION public.sync_voice_stripe_subscription(
  p_business_id uuid,p_stripe_customer_id text,p_stripe_subscription_id text,p_plan text,p_status text,
  p_current_period_start timestamptz,p_current_period_end timestamptz,p_stripe_price_id text,p_stripe_setup_fee_price_id text,
  p_stripe_checkout_session_id text,p_setup_fee_paid_at timestamptz,p_cancel_at_period_end boolean,p_updated_at timestamptz,
  p_revision bigint,p_effective_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.voice_billing_projection; changed boolean;
BEGIN
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.deleted_at IS NULL AND b.owner_id IS NOT NULL AND b.billing_mode='stripe' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO p FROM public.voice_billing_projection WHERE business_id=p_business_id FOR UPDATE;
  IF p.business_id IS NULL OR p.requested_revision IS DISTINCT FROM p_revision OR p_revision<=p.applied_revision THEN RETURN false; END IF;
  IF (p.subscription_id IS NOT NULL AND p.subscription_id<>p_stripe_subscription_id)
    OR EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.business_id=p_business_id
      AND (s.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id OR s.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id)) THEN RETURN false; END IF;
  IF p.period_start IS NOT NULL AND p_current_period_start<p.period_start THEN RETURN false; END IF;
  changed:=public.sync_stripe_subscription_if_business_active(p_business_id,p_stripe_customer_id,p_stripe_subscription_id,p_plan,p_status,
    p_current_period_start,p_current_period_end,p_stripe_price_id,p_stripe_setup_fee_price_id,p_stripe_checkout_session_id,p_setup_fee_paid_at,
    p_cancel_at_period_end,p_updated_at);
  IF NOT changed THEN RETURN false; END IF;
  IF NOT public.apply_voice_billing_projection(p_business_id,p_revision,p_stripe_subscription_id,p_plan,p_status,p_current_period_start,
    p_current_period_end,p_cancel_at_period_end,p_effective_at) THEN RAISE EXCEPTION 'voice billing projection rejected'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.configure_voice_commercial(p_business_id uuid,p_primary_response text,p_text_fallback_enabled boolean,p_expected_revision integer,p_owner_id uuid)
RETURNS public.voice_commercial_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_commercial_settings; reason text;
BEGIN
  IF p_primary_response IS NULL OR p_primary_response NOT IN ('text','voice') OR p_text_fallback_enabled IS NULL OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'invalid voice settings' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id=p_owner_id AND b.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p_owner_id IS NULL THEN RAISE EXCEPTION 'voice owner access denied' USING ERRCODE='42501'; END IF;
  IF p_business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' THEN RAISE EXCEPTION 'private pilot uses pilot controls' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.voice_commercial_settings WHERE business_id=p_business_id)
    AND NOT EXISTS(SELECT 1 FROM public.voice_rollout_businesses WHERE business_id=p_business_id) THEN
    RAISE EXCEPTION 'voice rollout unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO public.voice_commercial_settings(business_id) VALUES(p_business_id) ON CONFLICT DO NOTHING;
  SELECT * INTO cfg FROM public.voice_commercial_settings WHERE business_id=p_business_id FOR UPDATE;
  IF cfg.revision<>p_expected_revision THEN RAISE EXCEPTION 'voice settings changed; reload' USING ERRCODE='40001'; END IF;
  reason:=public.voice_commercial_access_reason(p_business_id);
  IF p_primary_response='voice' AND cfg.primary_response<>'voice' AND reason IS NOT NULL THEN
    RAISE EXCEPTION 'voice access unavailable: %',reason USING ERRCODE='42501'; END IF;
  UPDATE public.voice_commercial_settings SET primary_response=p_primary_response,text_fallback_enabled=p_text_fallback_enabled,
    revision=revision+1,updated_at=clock_timestamp() WHERE business_id=p_business_id RETURNING * INTO cfg;
  INSERT INTO public.voice_commercial_audit(business_id,kind,details) VALUES(p_business_id,'owner_settings',
    jsonb_build_object('revision',cfg.revision,'primary_response',cfg.primary_response,'text_fallback_enabled',cfg.text_fallback_enabled));
  RETURN cfg;
END $$;

CREATE FUNCTION public.get_voice_commercial_summary(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_commercial_settings; p public.voice_allowance_periods; pilot public.voice_pilot_settings;
  used numeric:=0; held numeric:=0; reason text; reconciling boolean:=false; visible boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id IS NOT NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'voice business unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO pilot FROM public.voice_pilot_settings WHERE business_id=p_business_id;
  IF pilot.business_id IS NOT NULL THEN
    SELECT COALESCE(sum(used_seconds),0),COALESCE(sum(GREATEST(used_seconds,reserved_seconds)-used_seconds),0),COALESCE(bool_or(NOT usage_confirmed AND status='closed'),false)
      INTO used,held,reconciling FROM public.voice_sessions WHERE business_id=p_business_id AND access_source='pilot';
    RETURN jsonb_build_object('visible',true,'access_source','pilot','eligible',pilot.enabled,'reason',CASE WHEN pilot.enabled THEN NULL ELSE 'rollout_closed' END,
      'primary_response',CASE WHEN pilot.enabled THEN 'voice' ELSE 'text' END,'text_fallback_enabled',true,'revision',pilot.revision,
      'period_id',NULL,'period_start',NULL,'period_end',NULL,'included_seconds',pilot.budget_seconds,'used_seconds',used,'held_seconds',held,
      'available_seconds',GREATEST(0,pilot.budget_seconds-used-held),'reconciling',reconciling,'policy_revision',1);
  END IF;
  SELECT * INTO cfg FROM public.voice_commercial_settings WHERE business_id=p_business_id;
  visible:=cfg.business_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.voice_rollout_businesses WHERE business_id=p_business_id)
    OR EXISTS(SELECT 1 FROM public.voice_allowance_periods WHERE business_id=p_business_id);
  SELECT a.* INTO p FROM public.voice_allowance_periods a JOIN public.voice_billing_projection b ON b.business_id=a.business_id
    AND b.subscription_id=a.subscription_id AND b.period_start=a.period_start WHERE a.business_id=p_business_id;
  IF p.id IS NOT NULL THEN
    SELECT COALESCE(sum(COALESCE(settled_seconds,0)),0),COALESCE(sum(CASE WHEN settled_at IS NULL THEN reserved_seconds ELSE 0 END),0),
      COALESCE(bool_or(state='reconciling'),false) INTO used,held,reconciling FROM public.voice_customer_usage WHERE period_id=p.id;
  END IF;
  reason:=public.voice_commercial_access_reason(p_business_id);
  IF reason IS NULL AND COALESCE(p.included_seconds,0)-used-held<60 THEN reason:='exhausted'; END IF;
  RETURN jsonb_build_object('visible',visible,'access_source','commercial','eligible',reason IS NULL,'reason',reason,
    'primary_response',COALESCE(cfg.primary_response,'text'),'text_fallback_enabled',COALESCE(cfg.text_fallback_enabled,true),'revision',COALESCE(cfg.revision,1),
    'period_id',p.id,'period_start',p.period_start,'period_end',p.period_end,'included_seconds',COALESCE(p.included_seconds,0),
    'used_seconds',used,'held_seconds',held,'available_seconds',GREATEST(0,COALESCE(p.included_seconds,0)-used-held),
    'reconciling',reconciling,'policy_revision',1);
END $$;

-- Admission lock order: global capacity -> business -> settings -> period.
-- Settlement locks business -> original period -> usage -> session, matching
-- admission and account deletion. It never obtains the global capacity lock. Ordinary billing/preference changes cannot revoke a
-- bounded existing grant. A failed primary response remains frozen on retries.
CREATE FUNCTION public.admit_voice_commercial(p_business_id uuid,p_call_control_id text,p_call_session_id text,p_caller text,p_called text,p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_commercial_settings; result public.voice_sessions; a public.voice_allowance_periods;
  global_cfg public.voice_rollout_control; reason text; committed numeric; reserved integer:=0; contact uuid; conversation uuid; identity_hash text;
BEGIN
  SELECT * INTO global_cfg FROM public.voice_rollout_control WHERE singleton FOR UPDATE;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.voice_sessions WHERE call_control_id=p_call_control_id;
  IF FOUND THEN
    IF ROW(result.business_id,result.call_session_id,result.caller_phone,result.called_phone) IS DISTINCT FROM ROW(p_business_id,p_call_session_id,p_caller,p_called) THEN
      RAISE EXCEPTION 'Call identity mismatch'; END IF;
    RETURN result;
  END IF;
  IF p_call_control_id IS NULL OR length(p_call_control_id) NOT BETWEEN 1 AND 1000 OR p_call_session_id IS NULL OR length(p_call_session_id) NOT BETWEEN 1 AND 1000
    OR p_caller IS NULL OR p_caller!~'^\+[1-9][0-9]{7,14}$' OR p_called IS NULL OR p_called!~'^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Invalid call identity'; END IF;
  identity_hash:=encode(extensions.digest(p_call_control_id,'sha256'),'hex');
  IF EXISTS(SELECT 1 FROM public.voice_customer_usage WHERE call_identity_hash=identity_hash) THEN
    RAISE EXCEPTION 'voice call history was deleted; replay denied' USING ERRCODE='55000'; END IF;
  SELECT * INTO cfg FROM public.voice_commercial_settings WHERE business_id=p_business_id FOR UPDATE;
  IF cfg.business_id IS NULL OR cfg.primary_response<>'voice'
    OR p_business_id='ea848911-ef72-44a6-8cf3-c47b3959be26'
    OR NOT EXISTS(SELECT 1 FROM public.phone_numbers WHERE business_id=p_business_id AND phone_number=p_called AND is_active) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM public.call_forwarding_attempts WHERE inbound_call_control_id=p_call_control_id AND status='connected') THEN RETURN NULL; END IF;
  reason:=public.voice_commercial_access_reason(p_business_id);
  IF reason IS NULL AND NOT COALESCE(p_worker_ready,false) THEN reason:='worker_unavailable'; END IF;
  IF reason IS NULL AND ((SELECT count(*) FROM public.voice_sessions v WHERE v.response_mode='voice' AND (v.status<>'closed'
    OR (v.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage u WHERE u.session_id=v.id AND u.termination_at IS NULL))))>=global_cfg.max_concurrent_calls
    OR (SELECT count(*) FROM public.voice_customer_usage WHERE business_id=p_business_id AND termination_at IS NULL AND settled_at IS NULL)>=2) THEN reason:='capacity_unavailable'; END IF;
  IF reason IS NULL THEN
    SELECT x.* INTO a FROM public.voice_allowance_periods x JOIN public.voice_billing_projection p ON p.business_id=x.business_id
      AND p.subscription_id=x.subscription_id AND p.period_start=x.period_start WHERE x.business_id=p_business_id FOR UPDATE OF x;
    SELECT COALESCE(sum(COALESCE(settled_seconds,reserved_seconds)),0) INTO committed FROM public.voice_customer_usage WHERE period_id=a.id;
    IF a.included_seconds-committed<60 THEN reason:='minutes_unavailable';
    ELSE reserved:=LEAST(600,floor(a.included_seconds-committed)::integer); END IF;
  END IF;
  IF reserved>0 THEN
    INSERT INTO public.contacts(business_id,phone_number,source_channel) VALUES(p_business_id,p_caller,'voice')
      ON CONFLICT(business_id,phone_number) WHERE phone_number IS NOT NULL DO UPDATE SET last_contacted_at=now() RETURNING id INTO contact;
    INSERT INTO public.conversations(business_id,contact_id,channel,is_ai_handling) VALUES(p_business_id,contact,'voice',false) RETURNING id INTO conversation;
  END IF;
  INSERT INTO public.voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,reserved_seconds,outcome,
    access_source,allowance_period_id,commercial_deadline_at,text_fallback_enabled,settings_revision)
    VALUES(p_business_id,conversation,p_call_control_id,p_call_session_id,p_caller,p_called,CASE WHEN reserved>0 THEN 'voice' ELSE 'text' END,reserved,reason,
      'commercial',CASE WHEN reserved>0 THEN a.id END,CASE WHEN reserved>0 THEN clock_timestamp()+make_interval(secs=>reserved+120) END,cfg.text_fallback_enabled,cfg.revision)
    RETURNING * INTO result;
  IF reserved>0 THEN
    INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds)
      VALUES(result.id,identity_hash,p_business_id,result.id,a.id,reserved);
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.voice_session_continuation_allowed(p_session_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.voice_sessions s JOIN public.businesses b ON b.id=s.business_id
    JOIN public.voice_customer_usage u ON u.session_id=s.id JOIN public.voice_rollout_control g ON g.singleton
    JOIN public.voice_rollout_businesses r ON r.business_id=s.business_id
    WHERE s.id=p_session_id AND s.access_source='commercial' AND s.response_mode='voice' AND s.status<>'closed' AND s.phone_ended_at IS NULL
      AND s.commercial_deadline_at>clock_timestamp() AND u.termination_at IS NULL AND u.settled_at IS NULL
      AND (u.started_at IS NOT NULL OR s.created_at+interval '120 seconds'>clock_timestamp())
      AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL
      AND NOT g.emergency_stop AND NOT r.emergency_stop
      AND EXISTS(SELECT 1 FROM public.phone_numbers n WHERE n.business_id=s.business_id AND n.phone_number=s.called_phone AND n.is_active));
$$;

-- Only these RPCs mutate customer time. Provider usage is an independent meter.
CREATE FUNCTION public.settle_voice_customer_usage(p_session_id uuid,p_allow_adjustment boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.voice_customer_usage; amount numeric; adjustment boolean:=false;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  SELECT * INTO u FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  IF u.call_key IS NULL THEN RETURN jsonb_build_object('state','not_commercial'); END IF;
  IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object('state',u.state,'settled_seconds',u.settled_seconds); END IF;
  IF u.termination_at IS NULL THEN RETURN jsonb_build_object('state',u.state); END IF;
  IF NOT u.evidence_conflict AND u.start_acknowledged_at IS NOT NULL AND u.ended_at>=u.started_at THEN
    amount:=LEAST(u.reserved_seconds,GREATEST(0,extract(epoch FROM (u.ended_at-u.started_at))));
  ELSIF p_allow_adjustment AND u.reconcile_after<=clock_timestamp() THEN
    -- Without independently verified start AND end, no uncertain seconds are
    -- charged. A late provider invoice cannot increase this frozen deduction.
    amount:=0; adjustment:=true;
  ELSE
    UPDATE public.voice_customer_usage SET state='reconciling' WHERE call_key=u.call_key;
    RETURN jsonb_build_object('state','reconciling');
  END IF;
  UPDATE public.voice_customer_usage SET state=CASE WHEN adjustment THEN 'adjusted' ELSE 'settled' END,settled_seconds=amount,
    settled_at=clock_timestamp(),adjustment_reason=CASE WHEN adjustment THEN 'unproven_customer_time_waived' END WHERE call_key=u.call_key;
  IF adjustment THEN INSERT INTO public.voice_commercial_audit(business_id,kind,details) VALUES(u.business_id,'usage_adjustment',
    jsonb_build_object('call_key',u.call_key,'period_id',u.period_id,'waived_hold_seconds',u.reserved_seconds)); END IF;
  RETURN jsonb_build_object('state',CASE WHEN adjustment THEN 'adjusted' ELSE 'settled' END,'settled_seconds',amount);
END $$;

CREATE FUNCTION public.record_voice_customer_start(p_session_id uuid,p_event_id text,p_started_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.voice_customer_usage;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  SELECT * INTO u FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  IF u.call_key IS NULL THEN RETURN jsonb_build_object('state','not_commercial'); END IF;
  IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object('state',u.state); END IF;
  IF NULLIF(p_event_id,'') IS NULL OR length(p_event_id)>200 OR p_started_at IS NULL OR p_started_at<u.created_at
    OR p_started_at>clock_timestamp()+interval '5 seconds' OR p_started_at>u.created_at+interval '120 seconds' THEN RAISE EXCEPTION 'invalid customer start evidence'; END IF;
  IF u.started_at IS NOT NULL AND ROW(u.started_at,u.start_event_id) IS DISTINCT FROM ROW(p_started_at,p_event_id) THEN
    UPDATE public.voice_customer_usage SET evidence_conflict=true,state='reconciling' WHERE call_key=u.call_key;
    RETURN jsonb_build_object('state','reconciling','conflict',true);
  END IF;
  UPDATE public.voice_customer_usage SET started_at=p_started_at,start_event_id=p_event_id WHERE call_key=u.call_key;
  UPDATE public.voice_sessions SET commercial_deadline_at=LEAST(commercial_deadline_at,p_started_at+make_interval(secs=>u.reserved_seconds)) WHERE id=u.session_id;
  RETURN jsonb_build_object('state',u.state);
END $$;

CREATE FUNCTION public.acknowledge_voice_customer_start(p_session_id uuid,p_event_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.voice_customer_usage;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  SELECT * INTO u FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  IF u.call_key IS NULL THEN RETURN jsonb_build_object('state','not_commercial'); END IF;
  IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object('state',u.state); END IF;
  IF u.started_at IS NULL OR u.start_event_id IS DISTINCT FROM p_event_id THEN RAISE EXCEPTION 'customer start acknowledgment mismatch'; END IF;
  UPDATE public.voice_customer_usage SET start_acknowledged_at=COALESCE(start_acknowledged_at,clock_timestamp()) WHERE call_key=u.call_key;
  RETURN public.settle_voice_customer_usage(p_session_id);
END $$;

CREATE FUNCTION public.record_voice_customer_end(p_session_id uuid,p_event_id text,p_ended_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.voice_customer_usage;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  SELECT * INTO u FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  IF u.call_key IS NULL THEN RETURN jsonb_build_object('state','not_commercial'); END IF;
  IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object('state',u.state,'settled_seconds',u.settled_seconds); END IF;
  IF NULLIF(p_event_id,'') IS NULL OR length(p_event_id)>200 OR p_ended_at IS NULL OR p_ended_at<u.created_at OR p_ended_at>clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'invalid customer end evidence'; END IF;
  IF u.ended_at=p_ended_at THEN RETURN public.settle_voice_customer_usage(p_session_id); END IF;
  IF u.ended_at IS NOT NULL AND u.ended_at IS DISTINCT FROM p_ended_at THEN
    UPDATE public.voice_customer_usage SET evidence_conflict=true,state='reconciling' WHERE call_key=u.call_key;
    RETURN jsonb_build_object('state','reconciling','conflict',true);
  END IF;
  UPDATE public.voice_customer_usage SET ended_at=p_ended_at,end_event_id=p_event_id,termination_at=COALESCE(termination_at,p_ended_at),
    termination_event_id=COALESCE(termination_event_id,p_event_id),reconcile_after=COALESCE(reconcile_after,clock_timestamp()+interval '24 hours'),
    evidence_conflict=evidence_conflict OR (started_at IS NOT NULL AND p_ended_at<started_at) WHERE call_key=u.call_key;
  UPDATE public.voice_sessions SET phone_ended_at=COALESCE(phone_ended_at,p_ended_at),provider_hangup_confirmed_at=COALESCE(provider_hangup_confirmed_at,clock_timestamp()) WHERE id=u.session_id;
  RETURN public.settle_voice_customer_usage(p_session_id);
END $$;

CREATE FUNCTION public.record_voice_customer_termination(p_session_id uuid,p_event_id text,p_terminated_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.voice_customer_usage;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  SELECT * INTO u FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  IF u.call_key IS NULL THEN RETURN jsonb_build_object('state','not_commercial'); END IF;
  IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object('state',u.state); END IF;
  IF NULLIF(p_event_id,'') IS NULL OR length(p_event_id)>200 OR p_terminated_at IS NULL OR p_terminated_at<u.created_at OR p_terminated_at>clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'invalid customer termination evidence'; END IF;
  UPDATE public.voice_customer_usage SET termination_at=COALESCE(termination_at,p_terminated_at),termination_event_id=COALESCE(termination_event_id,p_event_id),
    reconcile_after=COALESCE(reconcile_after,clock_timestamp()+interval '24 hours'),state='reconciling' WHERE call_key=u.call_key;
  UPDATE public.voice_sessions SET provider_hangup_confirmed_at=COALESCE(provider_hangup_confirmed_at,clock_timestamp()) WHERE id=u.session_id;
  RETURN public.settle_voice_customer_usage(p_session_id);
END $$;

CREATE FUNCTION public.reconcile_voice_customer_usage(p_limit integer DEFAULT 20) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u record; n integer:=0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid reconciliation limit'; END IF;
  FOR u IN SELECT call_key FROM public.voice_customer_usage WHERE settled_at IS NULL AND termination_at IS NOT NULL AND reconcile_after<=clock_timestamp()
    ORDER BY business_id,period_id,call_key LIMIT p_limit LOOP
    PERFORM public.settle_voice_customer_usage(u.call_key,true); n:=n+1;
  END LOOP;
  RETURN n;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
    'begin_voice_billing_reconciliation','apply_voice_billing_projection','sync_voice_stripe_subscription','voice_commercial_access_reason','configure_voice_commercial','get_voice_commercial_summary',
    'admit_voice_commercial','voice_session_continuation_allowed','settle_voice_customer_usage','record_voice_customer_start','acknowledge_voice_customer_start',
    'record_voice_customer_end','record_voice_customer_termination','reconcile_voice_customer_usage']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
COMMIT;
