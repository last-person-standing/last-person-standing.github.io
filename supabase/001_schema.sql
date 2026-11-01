-- =====================================================================
-- Last Person Standing - Stage 1: tables, security rules, helpers
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One row per user. Created automatically when someone is invited.
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null unique,
  display_name text not null default '',
  role         text not null default 'player' check (role in ('player', 'host')),
  credit       int  not null default 0 check (credit >= 0),   -- games of credit
  created_at   timestamptz not null default now()
);

create table public.teams (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  short_name text not null,
  -- PL / CH (Championship) / L1 / L2 / NL (non-league, only used in Custom weeks)
  league     text not null check (league in ('PL', 'CH', 'L1', 'L2', 'NL')),
  colour1    text not null check (colour1 ~ '^#[0-9A-Fa-f]{6}$'),
  colour2    text not null check (colour2 ~ '^#[0-9A-Fa-f]{6}$'),
  active     boolean not null default true   -- false = hidden, history kept
);

create table public.games (
  id          bigint generated always as identity primary key,
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'finished')),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  winner_note text
);
-- Only one game can be running at a time
create unique index games_one_active on public.games ((true)) where status = 'active';

create table public.gameweeks (
  id       bigint generated always as identity primary key,
  game_id  bigint not null references public.games(id) on delete cascade,
  number   int    not null,
  mode     text   not null default 'normal' check (mode in ('normal', 'off', 'custom')),
  deadline timestamptz not null,
  status   text   not null default 'open' check (status in ('open', 'resulted')),
  unique (game_id, number)
);
-- Only one open gameweek per game (the "current" one)
create unique index gameweeks_one_open on public.gameweeks (game_id) where status = 'open';

-- Teams allowed in a Custom week (FA Cup weekends etc.)
create table public.gameweek_teams (
  gameweek_id bigint not null references public.gameweeks(id) on delete cascade,
  team_id     bigint not null references public.teams(id),
  primary key (gameweek_id, team_id)
);

create table public.game_entries (
  game_id         bigint not null references public.games(id) on delete cascade,
  player_id       uuid   not null references public.profiles(id) on delete cascade,
  status          text   not null default 'alive' check (status in ('alive', 'out', 'winner')),
  out_gameweek_id bigint references public.gameweeks(id) on delete set null,
  entered_at      timestamptz not null default now(),
  primary key (game_id, player_id)
);

create table public.picks (
  id              bigint generated always as identity primary key,
  gameweek_id     bigint not null references public.gameweeks(id) on delete cascade,
  game_id         bigint not null references public.games(id) on delete cascade,
  player_id       uuid   not null references public.profiles(id) on delete cascade,
  team_id         bigint references public.teams(id),   -- empty while a reopened pick awaits a re-pick
  result          text   not null default 'pending' check (result in ('pending', 'won', 'lost')),
  reopen_deadline timestamptz,                         -- set when the host reopens after a postponement
  set_by          uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now(),
  unique (gameweek_id, player_id)
);
-- A team can only be used once per player per game
create unique index picks_team_once on public.picks (game_id, player_id, team_id) where team_id is not null;
create index picks_gameweek on public.picks (gameweek_id);

-- Every credit change, so there is a record of who added what
create table public.credit_log (
  id         bigint generated always as identity primary key,
  player_id  uuid not null references public.profiles(id) on delete cascade,
  change     int  not null,
  reason     text not null,
  game_id    bigint references public.games(id) on delete set null,
  by_user    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Chase email settings (a single row). Days: 1 = Monday ... 7 = Sunday. Hours are UK time.
create table public.email_settings (
  id         int primary key default 1 check (id = 1),
  enabled    boolean not null default true,
  send_slots jsonb   not null default '[{"day":3,"hour":9},{"day":4,"hour":9},{"day":5,"hour":9}]',
  subject    text    not null default 'Gameweek {gameweek}: make your pick before {deadline}',
  body       text    not null default E'Hi {name},\n\nYou are still in, but you have not picked a team for Gameweek {gameweek} yet.\n\nPicks lock at {deadline}. If you miss it, you are out.\n\nMake your pick here: {link}\n\nGood luck!'
);
insert into public.email_settings default values;

-- Which chase emails have gone out, so nobody gets the same one twice
create table public.email_log (
  id          bigint generated always as identity primary key,
  gameweek_id bigint not null references public.gameweeks(id) on delete cascade,
  player_id   uuid   not null references public.profiles(id) on delete cascade,
  slot        text   not null,   -- e.g. '2026-11-04 09' (UK date and hour)
  sent_at     timestamptz not null default now(),
  unique (gameweek_id, player_id, slot)
);

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

-- True if the logged-in user is a host
create function public.is_host() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = (select auth.uid()) and role = 'host'
  );
$$;

-- Next Friday 17:00 UK time after the given moment.
-- 'Europe/London' switches between GMT and BST automatically.
create function public.next_friday_deadline(p_from timestamptz default now()) returns timestamptz
language plpgsql stable set search_path = ''
as $$
declare
  v_local    timestamp := p_from at time zone 'Europe/London';
  v_friday   date      := v_local::date + ((5 - extract(isodow from v_local)::int + 7) % 7);
  v_deadline timestamptz := (v_friday + time '17:00') at time zone 'Europe/London';
begin
  if v_deadline <= p_from then
    v_deadline := ((v_friday + 7) + time '17:00') at time zone 'Europe/London';
  end if;
  return v_deadline;
end;
$$;

-- Create a profile automatically when a user is invited
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security: every table is locked down, then opened up
-- only as far as needed. Players never write to tables directly;
-- picks, credit and results go through checked functions (later stages).
-- ---------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.teams          enable row level security;
alter table public.games          enable row level security;
alter table public.gameweeks      enable row level security;
alter table public.gameweek_teams enable row level security;
alter table public.game_entries   enable row level security;
alter table public.picks          enable row level security;
alter table public.credit_log     enable row level security;
alter table public.email_settings enable row level security;
alter table public.email_log      enable row level security;

-- Logged-out visitors get nothing at all
revoke all on all tables in schema public from anon;

-- profiles: you see your own row; hosts see everyone (emails stay private).
-- Other players' names are shown via the overview functions in Stage 4.
create policy "Own profile or host" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_host()));

-- Players may change their own display name and nothing else
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy "Update own name" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- teams: everyone logged in can read; hosts can edit (promotion/relegation)
create policy "Read teams" on public.teams
  for select to authenticated using (true);
create policy "Hosts add teams" on public.teams
  for insert to authenticated with check ((select public.is_host()));
create policy "Hosts edit teams" on public.teams
  for update to authenticated using ((select public.is_host())) with check ((select public.is_host()));

-- games, gameweeks, entries: readable by everyone logged in
create policy "Read games" on public.games
  for select to authenticated using (true);
create policy "Read gameweeks" on public.gameweeks
  for select to authenticated using (true);
create policy "Read entries" on public.game_entries
  for select to authenticated using (true);

-- Custom-week team lists: everyone reads, hosts edit
create policy "Read gameweek teams" on public.gameweek_teams
  for select to authenticated using (true);
create policy "Hosts add gameweek teams" on public.gameweek_teams
  for insert to authenticated with check ((select public.is_host()));
create policy "Hosts remove gameweek teams" on public.gameweek_teams
  for delete to authenticated using ((select public.is_host()));

-- picks: you always see your own. Everyone else's become visible only
-- once the deadline has passed (and any reopened re-pick deadline too).
create policy "Own picks, or others after deadline" on public.picks
  for select to authenticated
  using (
    player_id = (select auth.uid())
    or (select public.is_host())
    or (
      exists (
        select 1 from public.gameweeks g
        where g.id = picks.gameweek_id and g.deadline <= now()
      )
      and (picks.reopen_deadline is null or picks.reopen_deadline <= now())
    )
  );

-- credit history: your own, or hosts see all
create policy "Own credit log or host" on public.credit_log
  for select to authenticated
  using (player_id = (select auth.uid()) or (select public.is_host()));

-- email settings and log: hosts only
create policy "Hosts read email settings" on public.email_settings
  for select to authenticated using ((select public.is_host()));
create policy "Hosts edit email settings" on public.email_settings
  for update to authenticated using ((select public.is_host())) with check ((select public.is_host()));
create policy "Hosts read email log" on public.email_log
  for select to authenticated using ((select public.is_host()));
