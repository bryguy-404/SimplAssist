BEGIN;

-- Hard deletion reaches usage through both the business and its call history.
-- Detach settled accounting while both parents still exist, before those
-- overlapping SET NULL/CASCADE actions can check a stale session reference.
-- Normal account tombstoning and all immutable accounting rules stay intact.
CREATE INDEX voice_customer_usage_business_id
  ON public.voice_customer_usage(business_id) WHERE business_id IS NOT NULL;

CREATE FUNCTION public.unlink_settled_voice_usage_on_business_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- DELETE already holds the business row, also used by admission/settlement.
  -- Lock history before usage to match a concurrent direct history deletion;
  -- taking usage first would invert that deletion's FK lock order.
  PERFORM id FROM public.voice_sessions
    WHERE business_id=OLD.id ORDER BY id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.voice_customer_usage
    WHERE business_id=OLD.id AND settled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'settle commercial voice before deleting its history'
      USING ERRCODE='55000';
  END IF;

  UPDATE public.voice_customer_usage SET business_id=NULL,session_id=NULL
    WHERE business_id=OLD.id AND settled_at IS NOT NULL;
  RETURN OLD;
END $$;

REVOKE ALL ON FUNCTION public.unlink_settled_voice_usage_on_business_delete()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER unlink_settled_voice_usage_on_business_delete
  BEFORE DELETE ON public.businesses FOR EACH ROW
  EXECUTE FUNCTION public.unlink_settled_voice_usage_on_business_delete();

COMMIT;
