begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(id, email) values ('00000000-0000-4000-abcd-000000000001', 'feedback@example.test');
insert into businesses(id, owner_id, name, business_type, slug, billing_mode)
values ('10000000-0000-4000-abcd-000000000001', '00000000-0000-4000-abcd-000000000001', 'Feedback Fixture', 'general', 'feedback-fixture', 'stripe');

create function pg_temp.act(action text, id uuid default null, rating text default null) returns text language sql as $$
  select public.dashboard_feedback_action('00000000-0000-4000-abcd-000000000001', '10000000-0000-4000-abcd-000000000001', action, id, rating);
$$;
create temp view prefs as select * from public.dashboard_feedback_preferences where owner_id = '00000000-0000-4000-abcd-000000000001';
select is(pg_temp.act('visit',gen_random_uuid()), 'quiet', 'first dashboard visit starts the clock');
update prefs set first_visit_at = now() - interval '7 days';
select is(pg_temp.act('visit',gen_random_uuid()), 'quiet', 'a week without product use stays quiet');
select pg_temp.act('activity');
select is(pg_temp.act('visit','20000000-0000-4000-abcd-000000000001'), 'show', 'first eligible return claims a card');
select is(pg_temp.act('visit',gen_random_uuid()), 'quiet', 'a second tab does not get another card');
select pg_temp.act('dismiss','20000000-0000-4000-abcd-000000000001');
select pg_temp.act('dismiss','20000000-0000-4000-abcd-000000000001');
select is((select dismissals::integer from prefs), 1, 'retried dismissal counted once');
select is((select next_prompt_at from prefs), now() + interval '30 days', 'snooze lasts thirty days');
update prefs set next_prompt_at = now(), has_activity = true;
select is(pg_temp.act('visit','20000000-0000-4000-abcd-000000000002'), 'show', 'snooze expires');
select pg_temp.act('dismiss','20000000-0000-4000-abcd-000000000002');
update prefs set next_prompt_at = now(), has_activity = true;
select is(pg_temp.act('visit',gen_random_uuid()), 'quiet', 'two dismissals suppress future automatic asks');
select is(pg_temp.act('submit','30000000-0000-4000-abcd-000000000001','Okay'), 'saved', 'manual feedback remains available');
select is(pg_temp.act('submit','30000000-0000-4000-abcd-000000000001','Okay'), 'saved', 'lost submission response can be retried');
select is((select count(*) from dashboard_feedback_responses where owner_id = '00000000-0000-4000-abcd-000000000001'), 1::bigint, 'retry stores a single email');
select is((select next_prompt_at from prefs), now() + interval '90 days', 'submission starts quarterly cooldown');
select is((select dismissals::integer from prefs), 2, 'a voluntary response preserves the opt-out');
select ok(not has_table_privilege('authenticated','dashboard_feedback_responses','SELECT'), 'client cannot read customer responses');
select ok(not has_function_privilege('anon','dashboard_feedback_action(uuid,uuid,text,uuid,text,text,text)','EXECUTE'), 'anonymous requests cannot write preferences');
select * from finish();
rollback;
