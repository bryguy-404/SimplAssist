create table public.dashboard_feedback_preferences (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  first_visit_at timestamptz,
  has_activity boolean not null default false,
  next_prompt_at timestamptz,
  prompt_id uuid,
  dismissals smallint not null default 0 check (dismissals between 0 and 2),
  last_submission_at timestamptz
);

create table public.dashboard_feedback_responses (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  business_name text not null,
  reply_email text,
  rating text not null check (rating in ('Great', 'Okay', 'Frustrating')),
  comment text not null check (char_length(comment) <= 1500),
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  sent_at timestamptz
);
create index dashboard_feedback_pending on public.dashboard_feedback_responses(next_attempt_at)
  where sent_at is null;
create index dashboard_feedback_by_owner on public.dashboard_feedback_responses(owner_id);
create index dashboard_feedback_by_business on public.dashboard_feedback_responses(business_id);

alter table public.dashboard_feedback_preferences enable row level security;
alter table public.dashboard_feedback_responses enable row level security;
revoke all on public.dashboard_feedback_preferences, public.dashboard_feedback_responses from public, anon, authenticated;
grant select, insert, update, delete on public.dashboard_feedback_preferences, public.dashboard_feedback_responses to service_role;

-- A real dashboard mount claims a prompt. Prefetches never call this function.
create function public.dashboard_feedback_action(
  p_owner uuid, p_business uuid, p_action text, p_id uuid default null,
  p_rating text default null, p_comment text default '', p_email text default null
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  prefs public.dashboard_feedback_preferences;
  company text;
begin
  select name into strict company from public.businesses
    where id = p_business and owner_id = p_owner and deleted_at is null;

  insert into public.dashboard_feedback_preferences(owner_id) values (p_owner) on conflict do nothing;
  select * into strict prefs from public.dashboard_feedback_preferences where owner_id = p_owner for update;

  case p_action
    when 'activity' then
      if not prefs.has_activity and prefs.dismissals < 2 then
        update public.dashboard_feedback_preferences set has_activity = true where owner_id = p_owner;
      end if;
    when 'visit' then
      if prefs.first_visit_at is null then
        update public.dashboard_feedback_preferences set first_visit_at = now() where owner_id = p_owner;
      elsif p_id = prefs.prompt_id then
        return 'show';
      elsif prefs.dismissals < 2 and prefs.has_activity and p_id is not null
        and prefs.first_visit_at <= now() - interval '7 days'
        and (prefs.next_prompt_at is null or prefs.next_prompt_at <= now()) then
        update public.dashboard_feedback_preferences set prompt_id = p_id, next_prompt_at = now() + interval '30 days',
          has_activity = false where owner_id = p_owner;
        return 'show';
      end if;
    when 'dismiss' then
      update public.dashboard_feedback_preferences set prompt_id = null, dismissals = least(2, dismissals + 1),
        next_prompt_at = now() + interval '30 days'
        where owner_id = p_owner and prompt_id = p_id;
    when 'submit' then
      if exists(select 1 from public.dashboard_feedback_responses where id = p_id and owner_id = p_owner) then
        return 'saved';
      end if;
      if prefs.last_submission_at > now() - interval '1 minute' then return 'slow_down'; end if;
      insert into public.dashboard_feedback_responses(id, owner_id, business_id, business_name, reply_email, rating, comment)
        values (p_id, p_owner, p_business, company, p_email, p_rating, p_comment);
      update public.dashboard_feedback_preferences set prompt_id = null, has_activity = false,
        last_submission_at = now(), next_prompt_at = now() + interval '90 days',
        dismissals = case when dismissals = 2 then 2 else 0 end where owner_id = p_owner;
      return 'saved';
    else raise exception 'unknown feedback action';
  end case;
  return 'quiet';
end;
$$;

-- One bounded delivery per claim. The lease also spaces retries after outages.
create function public.claim_dashboard_feedback_email(p_id uuid default null)
returns setof public.dashboard_feedback_responses language plpgsql security invoker set search_path = '' as $$
begin
  return query update public.dashboard_feedback_responses as response
    set next_attempt_at = now() + interval '5 minutes', first_attempt_at = coalesce(first_attempt_at, now())
    where response.id = (
      select candidate.id from public.dashboard_feedback_responses candidate
      where candidate.sent_at is null and candidate.next_attempt_at <= now()
        and (p_id is null or candidate.id = p_id)
        and (candidate.first_attempt_at is null or candidate.first_attempt_at > now() - interval '23 hours')
      order by candidate.next_attempt_at, candidate.id limit 1 for update skip locked
    )
    returning response.*;
  -- Surface ambiguous older sends for operator review after the provider's deduplication window.
  if not found and p_id is null and exists (
    select 1 from public.dashboard_feedback_responses where sent_at is null and first_attempt_at <= now() - interval '23 hours'
  ) then
    raise exception 'feedback_email_needs_review';
  end if;
end;
$$;
revoke all on function public.dashboard_feedback_action(uuid,uuid,text,uuid,text,text,text),
  public.claim_dashboard_feedback_email(uuid) from public, anon, authenticated;
grant execute on function public.dashboard_feedback_action(uuid,uuid,text,uuid,text,text,text),
  public.claim_dashboard_feedback_email(uuid) to service_role;
