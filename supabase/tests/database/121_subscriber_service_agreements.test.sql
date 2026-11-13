begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values ('00000000-0000-4000-a121-000000000001', 'agreements121@example.test');
insert into businesses (id, owner_id, name, business_type, slug, billing_mode)
select '10000000-0000-4000-a121-000000000001', '00000000-0000-4000-a121-000000000001', 'Agreement test', 'general', 'agreement121-test', 'stripe'
where not exists (select 1 from businesses where owner_id = '00000000-0000-4000-a121-000000000001');
create function pg_temp.business() returns uuid language sql as $$
  select id from public.businesses where owner_id = '00000000-0000-4000-a121-000000000001' limit 1;
$$;
update businesses set sms_consent_agreed=true, sms_consent_agreed_at='2020-01-01' where id=pg_temp.business();

insert into service_terms_versions(version,title,last_updated,terms_html,terms_sha256,checkbox_text,terms_url,privacy_url)
values ('test-v1','Terms','Test','<p>Historical terms</p>',repeat('a',64),'I agree to the Terms of Service and acknowledge the Privacy Policy.','https://simplassist.com/terms','https://simplassist.com/privacy'),
('test-v2','Terms','Test','<p>Later terms</p>',repeat('b',64),'I agree to the Terms of Service and acknowledge the Privacy Policy.','https://simplassist.com/terms','https://simplassist.com/privacy');

select ok(not has_table_privilege('authenticated','public.service_agreements','INSERT'), 'clients cannot manufacture agreement evidence');
select ok(not has_table_privilege('authenticated','public.service_agreements','SELECT'), 'clients cannot list other subscribers through database API');
select ok(not has_function_privilege('authenticated','public.record_service_agreement(uuid,uuid,text,text)','EXECUTE'), 'recording requires trusted server authorization');
select ok(not has_table_privilege('service_role','public.service_agreements','UPDATE'), 'server cannot overwrite acceptance timestamps');
select is((select count(*)::integer from service_agreements where business_id=pg_temp.business()),0,'an old SMS acknowledgment is not backfilled as Terms acceptance');
select throws_ok($$select record_service_agreement(pg_temp.business(),'00000000-0000-4000-a121-000000000002','test-v1','onboarding')$$,'P0001','service_agreement_owner_required','another user cannot accept for this business');

set local role service_role;
select (record_service_agreement(pg_temp.business(),'00000000-0000-4000-a121-000000000001','test-v1','onboarding')).id;
reset role;
select is((select subscriber_email from service_agreements where business_id=pg_temp.business()),'agreements121@example.test','subscriber identity is captured from authenticated ownership');
select ok((select accepted_at >= transaction_timestamp() from service_agreements where business_id=pg_temp.business()),'database records the submitted confirmation time');
create temporary table saved_agreement as select * from service_agreements where business_id=pg_temp.business();
select (record_service_agreement(pg_temp.business(),'00000000-0000-4000-a121-000000000001','test-v1','billing_checkout')).id;
select is((select count(*)::integer from service_agreements where business_id=pg_temp.business()),1,'payment retry reuses current acceptance');
select is((select accepted_at from service_agreements where business_id=pg_temp.business()),(select accepted_at from saved_agreement),'retries do not move the recorded acceptance time');
select is((select source from service_agreements where business_id=pg_temp.business()),'onboarding','retries retain the original submitted location');
select (record_service_agreement(pg_temp.business(),'00000000-0000-4000-a121-000000000001','test-v2','billing_settings')).id;
select is((select count(*)::integer from service_agreements where business_id=pg_temp.business()),2,'later terms create a retained history entry');
select is((select v.terms_html from service_terms_versions v join saved_agreement a on a.terms_version=v.version),'<p>Historical terms</p>','old agreement still returns its historical terms');
select throws_ok($$update service_agreements set source='billing_settings' where business_id=pg_temp.business()$$,'P0001','service_agreement_evidence_is_immutable','even privileged updates cannot silently alter evidence');
select throws_ok($$delete from service_terms_versions where version='test-v1'$$,'P0001','service_agreement_evidence_is_immutable','archived terms cannot be deleted under accepted records');
select is((select count(*)::integer from pg_constraint where conrelid='public.service_agreements'::regclass and confrelid in ('public.businesses'::regclass,'auth.users'::regclass)),0,'account lifecycle changes do not cascade-delete agreement history');
select * from finish();
rollback;
