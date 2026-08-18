-- Lightweight lead capture from the public demo walkthrough
-- (public/demos/contract-to-billing.html). Deliberately a single-field
-- capture (email only) distinct from design_partner_applications' fuller
-- form — a visitor who's only watched a 2-minute walkthrough hasn't earned
-- (or been asked for) company/role/pain-point yet.
create table if not exists demo_leads (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  source     text not null default 'demo_walkthrough',
  page_path  text,
  status     text not null default 'new' check (status in ('new', 'contacted', 'converted', 'ignored')),
  created_at timestamptz not null default now()
);

create index on demo_leads (created_at desc);
create index on demo_leads (email);

alter table demo_leads enable row level security;

do $$ begin
  create policy "service role bypass" on demo_leads for all using (true) with check (true);
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
