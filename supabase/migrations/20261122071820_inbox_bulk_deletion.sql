BEGIN;

-- The API resolves fresh workspace ownership and channel entitlements first.
-- This service-only operation repeats ownership and locks the selected parents
-- before checking dependants, so an appointment cannot race a bulk deletion.
CREATE FUNCTION public.delete_inbox_conversations(
  p_business_id uuid, p_owner_id uuid, p_ids uuid[]
) RETURNS TABLE (deleted_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE selected_ids uuid[]; selected_count integer;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 100
    OR array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_conversation_selection' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT id) INTO selected_ids FROM unnest(p_ids) AS ids(id);

  PERFORM 1 FROM public.businesses
    WHERE id = p_business_id AND owner_id = p_owner_id AND deleted_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.conversations
    WHERE business_id = p_business_id AND id = ANY(selected_ids)
    ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS selected_count = ROW_COUNT;
  IF selected_count <> cardinality(selected_ids) THEN
    RAISE EXCEPTION 'conversation_selection_changed' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.conversations
    WHERE business_id = p_business_id AND id = ANY(selected_ids)
      AND channel = 'voice' AND status <> 'closed')
    OR EXISTS (SELECT 1 FROM public.voice_sessions
      WHERE (conversation_id = ANY(selected_ids) OR action_conversation_id = ANY(selected_ids))
        AND status <> 'closed') THEN
    RAISE EXCEPTION 'conversation_call_in_progress' USING ERRCODE = 'P0001';
  END IF;

  -- Both booking FKs cascade. Refuse the whole batch rather than erase an
  -- appointment or strand an external calendar event during inbox cleanup.
  IF EXISTS (SELECT 1 FROM public.calendar_bookings b
    WHERE b.conversation_id = ANY(selected_ids)
      OR b.source_message_id IN (
        SELECT m.id FROM public.messages m WHERE m.conversation_id = ANY(selected_ids)
      )) THEN
    RAISE EXCEPTION 'conversation_has_appointments' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY DELETE FROM public.conversations c
    WHERE c.business_id = p_business_id AND c.id = ANY(selected_ids)
    RETURNING c.id;
  -- Voice sessions, immutable usage, contacts and recording cleanup identities
  -- survive through existing SET NULL foreign keys. No provider call is made.
END;
$$;

REVOKE ALL ON FUNCTION public.delete_inbox_conversations(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_inbox_conversations(uuid, uuid, uuid[]) TO service_role;

COMMIT;
