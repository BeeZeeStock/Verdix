alter table user_consents
  add column if not exists terms_version text not null default 'v1';
