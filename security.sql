-- security.sql — run once in Supabase → SQL Editor (safe to run again)
-- Session control, suspension, deactivation and account deletion.

alter table users add column if not exists token_version  integer     not null default 0;
alter table users add column if not exists suspended      boolean     not null default false;
alter table users add column if not exists suspended_reason text;
alter table users add column if not exists suspended_at   timestamptz;
alter table users add column if not exists deactivated_at timestamptz;
alter table users add column if not exists deleted_at     timestamptz;

-- Reset links: older links stop working once a newer one is used
create index if not exists password_resets_email_idx on password_resets (email);
