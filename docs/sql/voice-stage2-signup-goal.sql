-- Separate, explicit configuration change for Bryan's existing SimplAssist account.
-- Sets the shared text/voice goal to Signup. Does not enable any voice actions.
BEGIN;
DO $$
DECLARE b public.businesses;
BEGIN
  SELECT * INTO b FROM public.businesses
    WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26' FOR UPDATE;
  IF b.id IS NULL OR b.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Expected active SimplAssist account was not found';
  END IF;
  IF NOT ((b.primary_goal='book' AND b.goal_url IS NULL)
    OR (b.primary_goal='signup' AND b.goal_url='https://simplassist.com/signup')) THEN
    RAISE EXCEPTION 'Business goal changed; review before replacing it';
  END IF;
  UPDATE public.businesses SET primary_goal='signup', goal_url='https://simplassist.com/signup'
    WHERE id=b.id;
END $$;
COMMIT;
