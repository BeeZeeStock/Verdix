create table if not exists user_consents (
  email             text primary key,
  privacy_consent_at timestamptz not null,
  created_at        timestamptz not null default now()
);

alter table user_consents enable row level security;
create policy "service_role_bypass" on user_consents for all using (true);
