BEGIN;

-- Preserve the original one-item Chat upgrade. A paid review-SMS source is a
-- separate, narrowly bound path, never a general permission for extra items.
ALTER TABLE public.chat_texting_upgrades
 ADD COLUMN source_mode text NOT NULL DEFAULT 'new_sms' CHECK (source_mode IN ('new_sms','review_sms')),
 ADD COLUMN source_review_account_id uuid REFERENCES public.review_sms_accounts(id),
 ADD COLUMN source_review_item_id text,
 ADD COLUMN original_activation_operation_id uuid REFERENCES public.review_sms_billing_operations(id),
 ADD CONSTRAINT chat_texting_review_source_bound CHECK (
  (source_mode='new_sms' AND source_review_account_id IS NULL AND source_review_item_id IS NULL AND original_activation_operation_id IS NULL)
  OR (source_mode='review_sms' AND target_plan='sms_and_chat' AND source_review_account_id IS NOT NULL
   AND source_review_item_id IS NOT NULL AND source_review_item_id ~ '^si_[A-Za-z0-9]+$' AND original_activation_operation_id IS NOT NULL)
 );

-- Provider migration 113 replaces this with exact, durable handoff evidence.
-- Billing is fail-closed when the additive schema is deployed by itself.
CREATE FUNCTION public.review_texting_upgrade_provider_ready(p_upgrade_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION public.review_texting_upgrade_provider_ready(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_texting_upgrade_provider_ready(uuid) TO service_role;

COMMIT;
