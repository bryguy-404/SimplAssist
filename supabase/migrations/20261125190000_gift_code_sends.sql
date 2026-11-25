-- A record of every coupon email sent from /admin/gift-codes, so Bryan can
-- see who was sent which code. Written and read only by the server (service
-- role) behind the admin sign-in; no browser role may touch it.

create table public.gift_code_sends (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  recipient_email text not null check (char_length(recipient_email) between 3 and 320),
  recipient_first_name text check (char_length(recipient_first_name) <= 60),
  code text not null check (char_length(code) between 3 and 64),
  stripe_promotion_code_id text not null check (stripe_promotion_code_id ~ '^promo_[A-Za-z0-9]+$'),
  offer_summary text not null check (char_length(offer_summary) <= 200),
  code_expires_at timestamptz,
  sent_by uuid not null,
  sent_by_email text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  resend_email_id text
);

create index gift_code_sends_recent on public.gift_code_sends (created_at desc);
create index gift_code_sends_recipient_code on public.gift_code_sends (lower(recipient_email), lower(code));

alter table public.gift_code_sends enable row level security;

-- New tables get no automatic grants. Give the server exactly what it uses.
revoke all on public.gift_code_sends from public, anon, authenticated;
grant select, insert, update on public.gift_code_sends to service_role;
