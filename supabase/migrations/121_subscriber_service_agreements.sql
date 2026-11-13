-- Subscriber service agreement evidence is separate from recipient SMS consent.
-- No cascading FKs to accounts: cancellation/deletion must not silently rewrite
-- historical acceptance. Retention/purging is a separately authorized operation.
create table public.service_terms_versions (
  version text primary key,
  title text not null,
  last_updated text not null,
  terms_html text not null,
  terms_sha256 text not null check (terms_sha256 ~ '^[a-f0-9]{64}$'),
  checkbox_text text not null,
  terms_url text not null,
  privacy_url text not null,
  archived_at timestamptz not null default clock_timestamp()
);
create table public.service_agreements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  subscriber_id uuid not null,
  subscriber_email text not null,
  business_name text not null,
  terms_version text not null references public.service_terms_versions(version),
  accepted_at timestamptz not null default clock_timestamp(),
  source text not null check (source in ('onboarding', 'billing_checkout', 'plan_change', 'texting_upgrade', 'review_texting', 'billing_settings')),
  unique (business_id, subscriber_id, terms_version)
);
create index service_agreements_business_history on public.service_agreements (business_id, accepted_at desc);
create table public.service_agreement_references (
  agreement_id uuid not null references public.service_agreements(id),
  kind text not null check (kind in ('stripe_checkout', 'stripe_subscription', 'billing_operation', 'review_sms_operation')),
  reference text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (agreement_id, kind, reference)
);

alter table public.service_terms_versions enable row level security;
alter table public.service_agreements enable row level security;
alter table public.service_agreement_references enable row level security;
revoke all on public.service_terms_versions, public.service_agreements, public.service_agreement_references from public, anon, authenticated;
revoke all on public.service_terms_versions, public.service_agreements, public.service_agreement_references from service_role;
grant select, insert on public.service_terms_versions, public.service_agreement_references to service_role;
grant select on public.service_agreements to service_role;

create function public.preserve_service_agreement_evidence() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'service_agreement_evidence_is_immutable';
end;
$$;
create trigger preserve_service_terms before update or delete on public.service_terms_versions
for each row execute function public.preserve_service_agreement_evidence();
create trigger preserve_service_agreements before update or delete on public.service_agreements
for each row execute function public.preserve_service_agreement_evidence();
create trigger preserve_service_agreement_references before update or delete on public.service_agreement_references
for each row execute function public.preserve_service_agreement_evidence();

create function public.record_service_agreement(
  p_business_id uuid, p_subscriber_id uuid, p_terms_version text, p_source text
) returns public.service_agreements
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_email text;
  v_agreement public.service_agreements;
begin
  select b.name, u.email into v_name, v_email
  from public.businesses b join auth.users u on u.id = b.owner_id
  where b.id = p_business_id and b.owner_id = p_subscriber_id and b.deleted_at is null
  for share of b;
  if not found or v_email is null then
    raise exception 'service_agreement_owner_required';
  end if;
  insert into public.service_agreements (business_id, subscriber_id, subscriber_email, business_name, terms_version, source)
  values (p_business_id, p_subscriber_id, v_email, v_name, p_terms_version, p_source)
  on conflict (business_id, subscriber_id, terms_version) do nothing;
  select * into strict v_agreement from public.service_agreements
  where business_id = p_business_id and subscriber_id = p_subscriber_id and terms_version = p_terms_version;
  return v_agreement;
end;
$$;
revoke all on function public.record_service_agreement(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_service_agreement(uuid, uuid, text, text) to service_role;
revoke all on function public.preserve_service_agreement_evidence() from public, anon, authenticated;
