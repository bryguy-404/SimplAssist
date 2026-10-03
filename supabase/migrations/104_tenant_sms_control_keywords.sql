-- Keep provider control keywords out of automated conversations. Telnyx owns
-- their confirmations; the application persists suppression and human holds.
CREATE OR REPLACE FUNCTION public.tenant_sms_inbound(
  p_business uuid, p_profile text, p_phone text, p_text text, p_conversation uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  k text;
  normalized text;
  held boolean;
  b businesses;
BEGIN
  SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
  IF NOT FOUND OR b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile
    OR p_phone !~ '^\+[1-9][0-9]{7,14}$'
    OR NOT EXISTS(
      SELECT 1 FROM conversations c
      JOIN contacts t ON t.id=c.contact_id AND t.business_id=c.business_id
      WHERE c.id=p_conversation AND c.business_id=p_business AND c.channel='sms'
        AND t.phone_number=p_phone
    ) THEN
    RAISE EXCEPTION 'sms_inbound_identity_invalid';
  END IF;

  normalized:=upper(btrim(regexp_replace(p_text,'[[:space:]]+',' ','g')));
  k:=CASE
    WHEN normalized IN ('STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPT OUT') THEN 'stop'
    WHEN normalized IN ('START','UNSTOP') THEN 'start'
    WHEN normalized IN ('HELP','INFO') THEN 'help'
    ELSE NULL
  END;
  IF k='stop' THEN
    INSERT INTO tenant_sms_suppressions(business_id,messaging_profile_id,destination)
      VALUES(p_business,p_profile,p_phone)
      ON CONFLICT(business_id,messaging_profile_id,destination)
      DO UPDATE SET suppressed_at=now();
  ELSIF k='start' THEN
    DELETE FROM tenant_sms_suppressions
      WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_phone;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM tenant_sms_human_holds
    WHERE business_id=p_business AND messaging_profile_id=p_profile
      AND destination=p_phone AND released_at IS NULL
  ) INTO held;
  IF held THEN
    UPDATE tenant_sms_human_holds SET conversation_id=p_conversation
      WHERE business_id=p_business AND messaging_profile_id=p_profile
        AND destination=p_phone AND released_at IS NULL;
    UPDATE conversations SET is_ai_handling=false,status='handed_off' WHERE id=p_conversation;
  END IF;
  IF k='stop' OR held THEN
    IF to_regprocedure('public.review_stop_sms_destination(uuid,text,text)') IS NOT NULL THEN
      EXECUTE 'SELECT public.review_stop_sms_destination($1,$2,$3)'
        USING p_business,p_phone,CASE WHEN k='stop' THEN 'sms_stop' ELSE 'sms_reply' END;
    ELSE
      PERFORM review_stop_enrollment(id,CASE WHEN k='stop' THEN 'sms_stop' ELSE 'sms_reply' END)
        FROM review_enrollments
        WHERE business_id=p_business AND channel='sms' AND destination=p_phone AND status='active';
    END IF;
  END IF;
  RETURN jsonb_build_object('reviewHeld',held,'keyword',k);
END $$;

REVOKE ALL ON FUNCTION public.tenant_sms_inbound(uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_sms_inbound(uuid,text,text,text,uuid) TO service_role;
