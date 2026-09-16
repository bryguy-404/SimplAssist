BEGIN;

-- Saving contact details and sending a signup text are separate actions. The
-- backend may prepare the next permission question after a successful contact
-- save, but must never reuse that contact consent to send a text. Serialize the
-- transition with proposals/claims so a delayed contact result cannot replace
-- a newer caller request or retry an earlier signup attempt.
CREATE FUNCTION public.prepare_voice_signup_after_contact(
  p_session_id uuid,
  p_contact_action_id uuid,
  p_fingerprint text,
  p_payload jsonb,
  p_readback text
)
RETURNS public.voice_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  s public.voice_sessions;
  contact_action public.voice_actions;
  signup_action public.voice_actions;
  goal text;
  approved_url text;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR NOT public.voice_action_allowed(s.id,'signup') THEN RETURN NULL; END IF;

  SELECT * INTO contact_action FROM public.voice_actions
    WHERE id=p_contact_action_id AND session_id=s.id
      AND business_id=COALESCE(s.action_business_id,s.business_id)
    FOR UPDATE;
  IF contact_action.id IS NULL OR contact_action.kind<>'contact'
    OR contact_action.status<>'succeeded'
    OR contact_action.result IS NULL OR jsonb_typeof(contact_action.result)<>'object'
    OR NULLIF(btrim(contact_action.result->>'summary'),'') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.conversations conv
        JOIN public.contacts c ON c.id=conv.contact_id AND c.business_id=conv.business_id
      WHERE conv.id=COALESCE(s.action_conversation_id,s.conversation_id)
        AND conv.business_id=contact_action.business_id
        AND c.id::text=contact_action.result->>'contactId'
    ) THEN RETURN NULL; END IF;

  SELECT b.primary_goal,b.goal_url INTO goal,approved_url FROM public.businesses b
    WHERE b.id=contact_action.business_id;
  IF goal IS DISTINCT FROM 'signup' OR NULLIF(btrim(approved_url),'') IS NULL THEN RETURN NULL; END IF;
  -- Match normalizeHttpsGoalUrl's minimal normalization: trim and lowercase
  -- only the scheme. The stored goal URL already has the HTTPS constraint.
  approved_url:='https://'||substr(btrim(approved_url),9);
  IF p_payload IS DISTINCT FROM jsonb_build_object('kind','signup','approvedUrl',approved_url) THEN RETURN NULL; END IF;
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_readback IS NULL OR length(p_readback) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid signup continuation parameters';
  END IF;

  -- Only the stored contact request can seed an offer. It is not confirmation
  -- evidence for the new action, which still needs its own played readback and
  -- complete, later caller reply through claim_voice_action.
  IF COALESCE(cardinality(contact_action.request_event_ids),0) NOT BETWEEN 1 AND 100
    OR EXISTS (
      SELECT 1 FROM unnest(contact_action.request_event_ids) e
      WHERE NOT EXISTS (SELECT 1 FROM public.voice_transcript_fragments f
        WHERE f.session_id=s.id AND f.event_id=e AND f.role='customer')
    ) THEN RETURN NULL; END IF;

  IF EXISTS (SELECT 1 FROM public.voice_actions a
    WHERE a.session_id=s.id AND a.status IN ('executing','uncertain')) THEN RETURN NULL; END IF;

  SELECT * INTO signup_action FROM public.voice_actions a
    WHERE a.session_id=s.id AND a.kind='signup'
    ORDER BY a.revision DESC LIMIT 1 FOR UPDATE;
  IF signup_action.id IS NOT NULL THEN
    -- Repeating the same continuation is idempotent while its immediate
    -- successor is still pending. No prior attempt, changed URL, or intervening
    -- action can be revived or silently superseded.
    IF signup_action.status='awaiting_confirmation'
      AND signup_action.business_id=contact_action.business_id
      AND signup_action.revision=contact_action.revision+1
      AND signup_action.fingerprint=p_fingerprint
      AND signup_action.payload=p_payload
      AND signup_action.request_event_ids=contact_action.request_event_ids
      AND NOT EXISTS (SELECT 1 FROM public.voice_actions a
        WHERE a.session_id=s.id AND a.kind='signup' AND a.id<>signup_action.id)
      AND NOT EXISTS (SELECT 1 FROM public.voice_actions a
        WHERE a.session_id=s.id AND a.revision>contact_action.revision AND a.id<>signup_action.id)
    THEN RETURN signup_action; END IF;

    -- A caller may correct their contact details while the signup permission
    -- question is pending. The normal contact proposal supersedes that offer.
    -- After the corrected contact succeeds, reuse only that never-attempted
    -- signup row (its fingerprint is unique), as an entirely fresh question.
    -- No previous signup assent or playback survives this transition.
    IF signup_action.status='superseded'
      AND signup_action.business_id=contact_action.business_id
      AND signup_action.revision<contact_action.revision
      AND signup_action.fingerprint=p_fingerprint
      AND signup_action.payload=p_payload
      AND signup_action.confirmed_at IS NULL
      AND signup_action.source_message_id IS NULL
      AND signup_action.execution_started_at IS NULL
      AND signup_action.result IS NULL
      AND signup_action.error_code IS NULL
      AND signup_action.readback_event_ids IS NULL
      AND signup_action.confirmation_event_ids IS NULL
      AND signup_action.sms_logged_at IS NULL
      AND signup_action.reconciled_at IS NULL
      AND NOT signup_action.recovery_complete
      AND NOT EXISTS (SELECT 1 FROM public.voice_actions a
        WHERE a.session_id=s.id AND a.kind='signup' AND a.id<>signup_action.id)
      AND NOT EXISTS (SELECT 1 FROM public.voice_actions a
        WHERE a.session_id=s.id AND (a.revision>contact_action.revision OR a.status='awaiting_confirmation'))
    THEN
      UPDATE public.voice_actions SET status='awaiting_confirmation',revision=contact_action.revision+1,
        readback=p_readback,request_event_ids=contact_action.request_event_ids,
        playback_event_id=NULL,playback_at=NULL,playback_caller_end_ms=NULL,
        readback_event_ids=NULL,confirmation_event_ids=NULL,confirmed_at=NULL,
        execution_started_at=NULL,source_message_id=NULL,result=NULL,error_code=NULL,
        sms_logged_at=NULL,reconciled_at=NULL,recovery_complete=false,
        created_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=signup_action.id RETURNING * INTO signup_action;
      RETURN signup_action;
    END IF;
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.voice_actions a
    WHERE a.session_id=s.id AND (a.revision>contact_action.revision OR a.status='awaiting_confirmation')) THEN RETURN NULL; END IF;

  RETURN public.propose_voice_action(s.id,'signup',p_fingerprint,p_payload,p_readback,contact_action.request_event_ids);
END $$;

REVOKE ALL ON FUNCTION public.prepare_voice_signup_after_contact(uuid,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_voice_signup_after_contact(uuid,uuid,text,jsonb,text) TO service_role;
COMMIT;
