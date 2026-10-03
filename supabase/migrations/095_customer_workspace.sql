-- Shared Customers workspace. This migration does not activate outbound reviews.
ALTER TABLE public.contacts
  ADD COLUMN company text,
  ADD COLUMN service_address text,
  ADD COLUMN customer_stage text NOT NULL DEFAULT 'lead' CHECK (customer_stage IN ('lead','customer','inactive')),
  ADD COLUMN is_priority boolean NOT NULL DEFAULT false,
  ADD COLUMN owner_warmth_override text CHECK (owner_warmth_override IN ('normal','warm','hot')),
  ADD COLUMN next_follow_up_at timestamptz,
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags)<=30),
  ADD CONSTRAINT contacts_workspace_company_length CHECK (length(company)<=200),
  ADD CONSTRAINT contacts_workspace_address_length CHECK (length(service_address)<=1000),
  ADD CONSTRAINT contacts_id_business_workspace_unique UNIQUE(id,business_id);
ALTER TABLE public.contacts DROP CONSTRAINT contacts_source_channel_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_source_channel_check CHECK(source_channel IN ('sms','web_chat','voice','manual','csv_import'));
CREATE INDEX contacts_workspace_order ON public.contacts(business_id,created_at DESC,id);
CREATE INDEX contacts_workspace_stage ON public.contacts(business_id,customer_stage);
CREATE INDEX contacts_workspace_follow_up ON public.contacts(business_id,next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX contacts_workspace_email ON public.contacts(business_id,lower(btrim(email))) WHERE email IS NOT NULL;
CREATE INDEX contacts_workspace_tags ON public.contacts USING gin(tags);

CREATE TABLE public.customer_saved_views (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80), filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_saved_view_name ON public.customer_saved_views(business_id,lower(btrim(name)));
CREATE TABLE public.customer_service_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 contact_id uuid NOT NULL, description text CHECK(length(description)<=1000),
 service_date date, service_address_snapshot text, completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'completed' CHECK(status IN ('open','completed')), completed_at timestamptz,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128), request_fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(contact_id,business_id) REFERENCES public.contacts(id,business_id) ON DELETE CASCADE,
 UNIQUE(business_id,contact_id,idempotency_key), CHECK((status='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX customer_service_events_history ON public.customer_service_events(business_id,contact_id,created_at DESC);
CREATE TABLE public.customer_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL, rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=5000),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '2 hours'
);
CREATE INDEX customer_imports_business ON public.customer_imports(business_id,expires_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_saved_views','customer_service_events','customer_imports'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM anon,authenticated',t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
  IF t<>'customer_imports' THEN
   EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
   EXECUTE format('CREATE POLICY customer_workspace_read ON public.%I FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=business_id AND b.owner_id=auth.uid() AND b.deleted_at IS NULL))',t);
  END IF;
 END LOOP;
END $$;

-- Importing a known customer, or editing their record, is not captured demand.
-- Real inbound capture still executes the existing promotion rules.
CREATE OR REPLACE FUNCTION public.promote_contact_info_lead() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF current_setting('simplassist.customer_workspace_edit',true)='on'
    OR current_setting('role',true)='authenticated'
    OR (TG_OP='INSERT' AND NEW.source_channel IN ('manual','csv_import')) THEN RETURN NULL; END IF;
 IF public.lead_normalize_email(NEW.email) IS NOT NULL AND (TG_OP='INSERT' OR NEW.email IS DISTINCT FROM OLD.email) THEN
  PERFORM public.promote_contact_lead_status(NEW.business_id,NEW.id,'hot','email_captured');
 ELSIF public.lead_normalize_phone(NEW.provided_phone_number) IS NOT NULL AND (TG_OP='INSERT' OR NEW.provided_phone_number IS DISTINCT FROM OLD.provided_phone_number) THEN
  PERFORM public.promote_contact_lead_status(NEW.business_id,NEW.id,'hot','phone_captured');
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.record_contact_created_metric_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.business_id IS NULL OR NEW.created_at IS NULL OR NEW.source_channel IN ('manual','csv_import')
    OR current_setting('simplassist.customer_workspace_edit',true)='on' THEN RETURN NEW; END IF;
 BEGIN
  PERFORM public.record_business_metric_event_v1(NEW.business_id,'contact_created',1,NEW.created_at,'contact-created:'||NEW.id::text,NULL);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'business contact metric recording failed'; END;
 RETURN NEW;
END $$;

CREATE FUNCTION public.guard_customer_workspace_fields() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(NEW.tags) t WHERE t IS NULL OR length(btrim(t)) NOT BETWEEN 1 AND 50) THEN
  RAISE EXCEPTION 'customer_tags_invalid' USING ERRCODE='23514'; END IF;
 -- An unassigned legacy/admin fixture may be attached once by a trusted role;
 -- an already owned contact can never be transferred across tenants.
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.source_channel,NEW.session_id) IS DISTINCT FROM ROW(OLD.id,OLD.source_channel,OLD.session_id)
  OR (NEW.business_id IS DISTINCT FROM OLD.business_id AND NOT (OLD.business_id IS NULL AND NEW.business_id IS NOT NULL AND current_user NOT IN ('anon','authenticated')))) THEN
  RAISE EXCEPTION 'customer_identity_immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND current_setting('role',true)='authenticated' AND NEW.source_channel<>'manual' THEN
  RAISE EXCEPTION 'customer_source_invalid' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_customer_workspace_fields BEFORE INSERT OR UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.guard_customer_workspace_fields();

CREATE FUNCTION public.assert_customer_workspace(p_business_id uuid,p_owner_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'customer_workspace_denied' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION public.customer_workspace_match(p_business_id uuid,p_values jsonb,p_exclude_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE matches uuid[]; c public.contacts; email_value text:=nullif(lower(btrim(p_values->>'email')),''); phone_value text:=nullif(p_values->>'phone_number',''); k text; v jsonb; fill boolean:=false;
BEGIN
 SELECT array_agg(id) INTO matches FROM public.contacts WHERE business_id=p_business_id AND (p_exclude_id IS NULL OR id<>p_exclude_id)
  AND ((email_value IS NOT NULL AND lower(btrim(email))=email_value) OR (phone_value IS NOT NULL AND (phone_number=phone_value OR public.lead_normalize_phone(phone_number)=phone_value OR public.lead_normalize_phone(provided_phone_number)=phone_value)));
 IF cardinality(matches)>1 THEN RETURN jsonb_build_object('action','conflict','errors',jsonb_build_array('Email or phone matches more than one customer.')); END IF;
 IF coalesce(cardinality(matches),0)=0 THEN RETURN '{"action":"create","errors":[]}'::jsonb; END IF;
 SELECT * INTO c FROM public.contacts WHERE id=matches[1] AND business_id=p_business_id;
 IF (email_value IS NOT NULL AND nullif(btrim(c.email),'') IS NOT NULL AND lower(btrim(c.email))<>email_value)
 OR (phone_value IS NOT NULL AND coalesce(public.lead_normalize_phone(c.phone_number),public.lead_normalize_phone(c.provided_phone_number)) IS NOT NULL AND phone_value IS DISTINCT FROM public.lead_normalize_phone(c.phone_number) AND phone_value IS DISTINCT FROM public.lead_normalize_phone(c.provided_phone_number)) THEN
  RETURN jsonb_build_object('action','conflict','contactId',c.id,'errors',jsonb_build_array('Email and phone do not identify the same customer.'));
 END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p_values) LOOP
  IF k='phone_number' AND c.source_channel='web_chat' THEN k:='provided_phone_number'; END IF;
  IF k NOT IN ('customer_stage','is_priority','owner_warmth_override') AND v NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb)
   AND (to_jsonb(c)->k IS NULL OR to_jsonb(c)->k IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb)) THEN fill:=true; END IF;
 END LOOP;
 RETURN jsonb_build_object('action',CASE WHEN fill THEN 'fill_blanks' ELSE 'skip' END,'contactId',c.id,'errors','[]'::jsonb);
END $$;

CREATE FUNCTION public.customer_workspace_save(p_business_id uuid,p_owner_id uuid,p_contact_id uuid,p_values jsonb,p_source text DEFAULT 'manual',p_fill_blanks boolean DEFAULT false) RETURNS public.contacts
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.contacts; candidate public.contacts; matches jsonb; k text; v jsonb; prior_setting text:=current_setting('simplassist.customer_workspace_edit',true);
BEGIN
 PERFORM public.assert_customer_workspace(p_business_id,p_owner_id);
 IF jsonb_typeof(p_values)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) AS keys(value) WHERE keys.value NOT IN ('name','company','email','phone_number','service_address','notes','customer_stage','is_priority','owner_warmth_override','next_follow_up_at','tags')) THEN
  RAISE EXCEPTION 'customer_fields_invalid' USING ERRCODE='22023'; END IF;
 IF p_source NOT IN ('manual','csv_import') THEN RAISE EXCEPTION 'customer_source_invalid' USING ERRCODE='22023'; END IF;
 IF p_contact_id IS NOT NULL THEN
  SELECT * INTO c FROM public.contacts WHERE id=p_contact_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer_not_found' USING ERRCODE='P0002'; END IF;
  -- Public chat identity stays session-bound. Owner phone edits are contact
  -- details, never a replacement for the widget's original routing identity.
  IF p_values?'phone_number' AND (c.source_channel='web_chat' OR (c.phone_number IS NOT NULL AND public.lead_normalize_phone(c.phone_number) IS NULL)) THEN
   p_values:=(p_values-'phone_number')||jsonb_build_object('provided_phone_number',p_values->'phone_number');
  END IF;
  IF p_fill_blanks THEN
   FOR k,v IN SELECT * FROM jsonb_each(p_values) LOOP
    IF k IN ('customer_stage','is_priority','owner_warmth_override') OR (to_jsonb(c)->k IS NOT NULL AND to_jsonb(c)->k NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb)) THEN p_values:=p_values-k; END IF;
   END LOOP;
  END IF;
 ELSE
  c.customer_stage:='customer'; c.is_priority:=false; c.tags:='{}';
 END IF;
 candidate:=jsonb_populate_record(c,p_values);
 candidate.email:=nullif(lower(btrim(candidate.email)),''); candidate.phone_number:=nullif(candidate.phone_number,'');
 IF (p_contact_id IS NULL OR candidate.phone_number IS DISTINCT FROM c.phone_number) AND candidate.phone_number IS NOT NULL AND candidate.phone_number !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'customer_phone_invalid' USING ERRCODE='22023'; END IF;
 IF candidate.provided_phone_number IS DISTINCT FROM c.provided_phone_number AND candidate.provided_phone_number IS NOT NULL AND candidate.provided_phone_number !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'customer_phone_invalid' USING ERRCODE='22023'; END IF;
 IF candidate.email IS NOT NULL AND (length(candidate.email)>254 OR candidate.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN RAISE EXCEPTION 'customer_email_invalid' USING ERRCODE='22023'; END IF;
 IF coalesce(length(candidate.name),0)>200 OR coalesce(length(candidate.notes),0)>10000 OR candidate.customer_stage IS NULL OR candidate.tags IS NULL OR candidate.is_priority IS NULL
  OR coalesce(nullif(btrim(candidate.name),''),nullif(btrim(candidate.company),''),candidate.email,candidate.phone_number,candidate.provided_phone_number) IS NULL THEN
  RAISE EXCEPTION 'customer_fields_invalid' USING ERRCODE='22023'; END IF;
 IF p_contact_id IS NULL OR candidate.email IS DISTINCT FROM c.email OR candidate.phone_number IS DISTINCT FROM c.phone_number OR candidate.provided_phone_number IS DISTINCT FROM c.provided_phone_number THEN
  matches:=public.customer_workspace_match(p_business_id,jsonb_build_object('email',candidate.email,'phone_number',CASE WHEN c.source_channel='web_chat' OR (c.phone_number IS NOT NULL AND public.lead_normalize_phone(c.phone_number) IS NULL) THEN candidate.provided_phone_number ELSE candidate.phone_number END),p_contact_id);
  IF matches->>'action'<>'create' THEN RAISE EXCEPTION 'customer_identity_conflict' USING ERRCODE='23505'; END IF;
 END IF;
 PERFORM set_config('simplassist.customer_workspace_edit','on',true);
 IF p_contact_id IS NULL THEN
  INSERT INTO public.contacts(business_id,name,email,phone_number,source_channel,notes,company,service_address,customer_stage,is_priority,owner_warmth_override,next_follow_up_at,tags)
  VALUES(p_business_id,candidate.name,candidate.email,candidate.phone_number,p_source,candidate.notes,candidate.company,candidate.service_address,candidate.customer_stage,candidate.is_priority,candidate.owner_warmth_override,candidate.next_follow_up_at,candidate.tags) RETURNING * INTO c;
 ELSE
  UPDATE public.contacts SET name=candidate.name,email=candidate.email,phone_number=candidate.phone_number,provided_phone_number=candidate.provided_phone_number,notes=candidate.notes,company=candidate.company,service_address=candidate.service_address,
   customer_stage=candidate.customer_stage,is_priority=candidate.is_priority,owner_warmth_override=candidate.owner_warmth_override,next_follow_up_at=candidate.next_follow_up_at,tags=candidate.tags
  WHERE id=p_contact_id AND business_id=p_business_id RETURNING * INTO c;
 END IF;
 PERFORM set_config('simplassist.customer_workspace_edit',coalesce(prior_setting,''),true);
 RETURN c;
END $$;

CREATE FUNCTION public.customer_workspace_delete(p_business_id uuid,p_owner_id uuid,p_contact_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.assert_customer_workspace(p_business_id,p_owner_id);
 PERFORM 1 FROM public.contacts WHERE id=p_contact_id AND business_id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'customer_not_found' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.conversations WHERE contact_id=p_contact_id AND business_id=p_business_id AND channel='voice') THEN
  RAISE EXCEPTION 'customer_voice_history_protected' USING ERRCODE='23514'; END IF;
 DELETE FROM public.contacts WHERE id=p_contact_id AND business_id=p_business_id;
 RETURN true;
END $$;

CREATE FUNCTION public.customer_workspace_list(p_business_id uuid,p_filters jsonb DEFAULT '{}',p_page integer DEFAULT 1,p_page_size integer DEFAULT 25) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH owned AS (SELECT * FROM public.contacts WHERE business_id=p_business_id), filtered AS (
 SELECT * FROM owned WHERE (coalesce(p_filters->>'q','')='' OR strpos(lower(concat_ws(' ',name,email,phone_number,provided_phone_number,company,service_address)),lower(p_filters->>'q'))>0)
 AND (coalesce(p_filters->>'source','')='' OR source_channel=p_filters->>'source')
 AND (coalesce(p_filters->>'tag','')='' OR tags @> ARRAY[p_filters->>'tag'])
 AND CASE coalesce(p_filters->>'view','all') WHEN 'all' THEN true WHEN 'leads' THEN customer_stage='lead' WHEN 'customers' THEN customer_stage='customer'
 WHEN 'inactive' THEN customer_stage='inactive' WHEN 'hot' THEN coalesce(owner_warmth_override,lead_status)='hot' WHEN 'priority' THEN is_priority
 WHEN 'follow_up_due' THEN next_follow_up_at<=now() AND customer_stage<>'inactive' ELSE false END),
 paged AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT greatest(1,least(p_page_size,1000)) OFFSET (greatest(p_page,1)-1)*greatest(1,least(p_page_size,1000)))
 SELECT jsonb_build_object('customers',coalesce((SELECT jsonb_agg(to_jsonb(paged)) FROM paged),'[]'::jsonb),
 'pagination',jsonb_build_object('page',greatest(p_page,1),'pageSize',greatest(1,least(p_page_size,1000)),'total',(SELECT count(*) FROM filtered),'totalPages',ceil((SELECT count(*) FROM filtered)::numeric/greatest(1,least(p_page_size,1000)))),
 'counts',(SELECT jsonb_build_object('total',count(*),'leads',count(*) FILTER(WHERE customer_stage='lead'),'customers',count(*) FILTER(WHERE customer_stage='customer'),
 'hot',count(*) FILTER(WHERE coalesce(owner_warmth_override,lead_status)='hot'),'priority',count(*) FILTER(WHERE is_priority),'followUpDue',count(*) FILTER(WHERE next_follow_up_at<=now() AND customer_stage<>'inactive')) FROM owned),
 'savedViews',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.name) FROM public.customer_saved_views v WHERE business_id=p_business_id),'[]'::jsonb));
$$;

CREATE FUNCTION public.customer_workspace_export_page(p_business_id uuid,p_filters jsonb,p_before timestamptz,p_after_created timestamptz DEFAULT NULL,p_after_id uuid DEFAULT NULL) RETURNS SETOF public.contacts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.* FROM public.contacts c WHERE c.business_id=p_business_id AND c.created_at<=p_before
 AND (p_after_created IS NULL OR (c.created_at,c.id)<(p_after_created,p_after_id))
 AND (coalesce(p_filters->>'q','')='' OR strpos(lower(concat_ws(' ',c.name,c.email,c.phone_number,c.provided_phone_number,c.company,c.service_address)),lower(p_filters->>'q'))>0)
 AND (coalesce(p_filters->>'source','')='' OR c.source_channel=p_filters->>'source')
 AND (coalesce(p_filters->>'tag','')='' OR c.tags @> ARRAY[p_filters->>'tag'])
 AND CASE coalesce(p_filters->>'view','all') WHEN 'all' THEN true WHEN 'leads' THEN c.customer_stage='lead' WHEN 'customers' THEN c.customer_stage='customer'
 WHEN 'inactive' THEN c.customer_stage='inactive' WHEN 'hot' THEN coalesce(c.owner_warmth_override,c.lead_status)='hot' WHEN 'priority' THEN c.is_priority
 WHEN 'follow_up_due' THEN c.next_follow_up_at<=now() AND c.customer_stage<>'inactive' ELSE false END
 ORDER BY c.created_at DESC,c.id DESC LIMIT 1000;
$$;

CREATE FUNCTION public.customer_workspace_saved_view(p_business_id uuid,p_owner_id uuid,p_id uuid,p_name text,p_filters jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ DECLARE v public.customer_saved_views; BEGIN
 PERFORM public.assert_customer_workspace(p_business_id,p_owner_id);
 IF p_id IS NOT NULL THEN
  DELETE FROM public.customer_saved_views WHERE id=p_id AND business_id=p_business_id RETURNING * INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer_view_not_found' USING ERRCODE='P0002'; END IF;
 ELSE
  IF (SELECT count(*) FROM public.customer_saved_views WHERE business_id=p_business_id)>=50 THEN RAISE EXCEPTION 'customer_view_limit' USING ERRCODE='23514'; END IF;
  INSERT INTO public.customer_saved_views(business_id,name,filters) VALUES(p_business_id,btrim(p_name),p_filters) RETURNING * INTO v;
 END IF;
 RETURN to_jsonb(v);
END $$;

CREATE FUNCTION public.customer_workspace_service_event(p_business_id uuid,p_owner_id uuid,p_contact_id uuid,p_event_id uuid,p_values jsonb) RETURNS public.customer_service_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ DECLARE e public.customer_service_events; wanted text; BEGIN
 PERFORM public.assert_customer_workspace(p_business_id,p_owner_id);
 PERFORM 1 FROM public.contacts WHERE id=p_contact_id AND business_id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'customer_not_found' USING ERRCODE='P0002'; END IF;
 IF p_event_id IS NULL THEN
  SELECT * INTO e FROM public.customer_service_events WHERE business_id=p_business_id AND contact_id=p_contact_id AND idempotency_key=p_values->>'idempotencyKey' FOR UPDATE;
  IF FOUND THEN
   IF e.request_fingerprint<>p_values::text THEN RAISE EXCEPTION 'customer_event_idempotency_conflict' USING ERRCODE='23505'; END IF;
   RETURN e;
  END IF;
  INSERT INTO public.customer_service_events(business_id,contact_id,description,completed_at,idempotency_key,request_fingerprint,service_date,service_address_snapshot,completed_by)
  VALUES(p_business_id,p_contact_id,nullif(btrim(p_values->>'description'),''),coalesce((p_values->>'completedAt')::timestamptz,now()),p_values->>'idempotencyKey',p_values::text,
   (p_values->>'serviceDate')::date,(SELECT service_address FROM public.contacts WHERE id=p_contact_id AND business_id=p_business_id),p_owner_id) RETURNING * INTO e;
 ELSE
  SELECT * INTO e FROM public.customer_service_events WHERE id=p_event_id AND business_id=p_business_id AND contact_id=p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer_event_not_found' USING ERRCODE='P0002'; END IF;
  wanted:=p_values->>'status';
  IF wanted NOT IN ('open','completed') OR wanted IS NULL THEN RAISE EXCEPTION 'customer_event_status_invalid' USING ERRCODE='22023'; END IF;
  IF e.status=wanted THEN RETURN e; END IF;
  UPDATE public.customer_service_events SET status=wanted,completed_at=CASE WHEN wanted='completed' THEN now() ELSE NULL END,completed_by=CASE WHEN wanted='completed' THEN p_owner_id ELSE NULL END,updated_at=now() WHERE id=e.id RETURNING * INTO e;
 END IF;
 RETURN e;
END $$;

CREATE FUNCTION public.customer_workspace_import_preview(p_business_id uuid,p_owner_id uuid,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row_value jsonb; match_value jsonb; output jsonb:='[]'; seen_emails text[]:='{}'; seen_phones text[]:='{}'; email_value text; phone_value text; import_id uuid; BEGIN
 PERFORM public.assert_customer_workspace(p_business_id,p_owner_id);
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'customer_import_invalid' USING ERRCODE='22023'; END IF;
 DELETE FROM public.customer_imports WHERE business_id=p_business_id AND expires_at<now();
 FOR row_value IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
  IF row_value->>'action'='conflict' THEN output:=output||jsonb_build_array(row_value); CONTINUE; END IF;
  email_value:=row_value->'values'->>'email'; phone_value:=row_value->'values'->>'phone_number';
  IF email_value=ANY(seen_emails) OR phone_value=ANY(seen_phones) THEN
   row_value:=row_value||'{"action":"conflict","errors":["Duplicate destination within this CSV. Keep one row per customer."]}'::jsonb;
  ELSE
   match_value:=public.customer_workspace_match(p_business_id,row_value->'values');
   row_value:=row_value||match_value;
   IF email_value IS NOT NULL THEN seen_emails:=array_append(seen_emails,email_value); END IF;
   IF phone_value IS NOT NULL THEN seen_phones:=array_append(seen_phones,phone_value); END IF;
  END IF;
  output:=output||jsonb_build_array(row_value);
 END LOOP;
 INSERT INTO public.customer_imports(business_id,owner_id,rows) VALUES(p_business_id,p_owner_id,output) RETURNING id INTO import_id;
 RETURN jsonb_build_object('previewToken',import_id,'rows',output);
END $$;

CREATE FUNCTION public.customer_workspace_import_commit(p_business_id uuid,p_owner_id uuid,p_import_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE batch public.customer_imports; row_value jsonb; decision jsonb; c public.contacts; results jsonb:='[]'; item jsonb; created_count integer:=0; updated_count integer:=0; skipped_count integer:=0; conflicts_count integer:=0; result_value jsonb; BEGIN
 PERFORM public.assert_customer_workspace(p_business_id,p_owner_id);
 SELECT * INTO batch FROM public.customer_imports WHERE id=p_import_id AND business_id=p_business_id AND owner_id=p_owner_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'customer_import_not_found' USING ERRCODE='P0002'; END IF;
 IF batch.result IS NOT NULL THEN RETURN batch.result; END IF;
 IF batch.expires_at<now() THEN RAISE EXCEPTION 'customer_import_expired' USING ERRCODE='23514'; END IF;
 FOR row_value IN SELECT * FROM jsonb_array_elements(batch.rows) LOOP
  item:=jsonb_build_object('rowNumber',row_value->'rowNumber');
  BEGIN
   IF row_value->>'action'='conflict' THEN
    item:=item||jsonb_build_object('status','conflict','error',coalesce(row_value->'errors'->>0,'Resolve this row and import again.')); conflicts_count:=conflicts_count+1;
   ELSE
    decision:=public.customer_workspace_match(p_business_id,row_value->'values');
    IF decision->>'action'='conflict' OR (row_value->>'action'='create' AND decision->>'action'<>'create') OR
       (row_value->>'action'<>'create' AND decision->>'contactId' IS DISTINCT FROM row_value->>'contactId') THEN
     item:=item||jsonb_build_object('status','conflict','error','Customer identity changed after preview. Preview this row again.'); conflicts_count:=conflicts_count+1;
    ELSIF decision->>'action'='skip' OR row_value->>'action'='skip' THEN
     item:=item||jsonb_build_object('status','skipped','contactId',decision->>'contactId'); skipped_count:=skipped_count+1;
    ELSE
     c:=public.customer_workspace_save(p_business_id,p_owner_id,(decision->>'contactId')::uuid,row_value->'values','csv_import',decision->>'action'='fill_blanks');
     IF decision->>'action'='create' THEN created_count:=created_count+1; item:=item||jsonb_build_object('status','created','contactId',c.id);
     ELSE updated_count:=updated_count+1; item:=item||jsonb_build_object('status','updated','contactId',c.id); END IF;
    END IF;
   END IF;
  EXCEPTION WHEN unique_violation OR check_violation OR invalid_parameter_value THEN
   item:=item||jsonb_build_object('status','conflict','error','Customer changed or contains conflicting information. Preview this row again.'); conflicts_count:=conflicts_count+1;
  END;
  results:=results||jsonb_build_array(item);
 END LOOP;
 result_value:=jsonb_build_object('importId',batch.id,'created',created_count,'updated',updated_count,'skipped',skipped_count,'conflicts',conflicts_count,'rows',results);
 -- Drop normalized customer payload immediately after commit. Retain only receipt IDs/statuses.
 UPDATE public.customer_imports SET result=result_value,rows='[]',expires_at=now()+interval '7 days' WHERE id=batch.id;
 RETURN result_value;
END $$;

CREATE FUNCTION public.cleanup_customer_workspace_on_tombstone() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN
  UPDATE public.contacts SET company=NULL,service_address=NULL,next_follow_up_at=NULL,tags='{}',owner_warmth_override=NULL,is_priority=false WHERE business_id=NEW.id;
  DELETE FROM public.customer_service_events WHERE business_id=NEW.id;
  DELETE FROM public.customer_saved_views WHERE business_id=NEW.id;
  DELETE FROM public.customer_imports WHERE business_id=NEW.id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cleanup_customer_workspace_on_tombstone AFTER UPDATE OF owner_id ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.cleanup_customer_workspace_on_tombstone();

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND
 (p.proname LIKE 'customer_workspace_%' OR p.proname IN ('assert_customer_workspace','guard_customer_workspace_fields','cleanup_customer_workspace_on_tombstone')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  IF f.signature::text NOT LIKE 'guard_%' AND f.signature::text NOT LIKE 'cleanup_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
 END LOOP;
END $$;
