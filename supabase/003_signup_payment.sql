-- =====================================================================
-- Last Person Standing - open sign-up and payment details
-- Run AFTER 001_schema.sql and 002_seed_teams.sql.
-- =====================================================================

-- Each player gets a number, used in their bank payment reference (e.g. LPS-12-JASON)
alter table public.profiles add column player_no int generated always as identity unique;

-- Keep names to a sensible length (people now sign themselves up)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 60)
  );
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

alter table public.profiles
  add constraint display_name_length check (char_length(trim(display_name)) between 1 and 60);

-- App-wide settings (a single row): the host's bank details for players to pay into
create table public.app_settings (
  id                 int  primary key default 1 check (id = 1),
  pay_account_name   text not null default '',
  pay_sort_code      text not null default '',
  pay_account_number text not null default '',
  pay_note           text not null default '£5 per game. Please use your reference so the host knows the payment is from you.',
  pay_ref_prefix     text not null default 'LPS' check (pay_ref_prefix ~ '^[A-Z0-9]{1,5}$')
);
insert into public.app_settings default values;

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon;

-- Logged-in players can read the payment details; only hosts can change them
create policy "Read settings" on public.app_settings
  for select to authenticated using (true);
create policy "Hosts edit settings" on public.app_settings
  for update to authenticated using ((select public.is_host())) with check ((select public.is_host()));
