-- =====================================================================
-- Last Person Standing - message players (an email from a host to the group)
-- Run AFTER 008_schedule_chase.sql. Safe to run again.
-- =====================================================================

-- One row per message a host sends, so both hosts can see what went out
create table if not exists public.message_log (
  id          bigint generated always as identity primary key,
  request_id  uuid   not null unique,   -- stops the same message going out twice if Send is retried
  sent_by     uuid   references public.profiles(id) on delete set null,
  sender_name text   not null,
  audience    text   not null check (audience in ('everyone', 'game')),
  game_name   text,                     -- the game, when sent to everyone in a game
  subject     text   not null,
  body        text   not null,
  recipients  int    not null default 0,
  failed      int    not null default 0,
  status      text   not null default 'sending' check (status in ('sending', 'sent')),
  sent_at     timestamptz not null default now()
);

alter table public.message_log enable row level security;
revoke all on public.message_log from anon;

-- Hosts can read it; only the email function (service role) writes to it
drop policy if exists "Hosts read message log" on public.message_log;
create policy "Hosts read message log" on public.message_log
  for select to authenticated using ((select public.is_host()));

-- The game a message can go to: the running game, or the most recent one if none is running
create or replace function public.message_game() returns public.games
language sql stable security definer set search_path = ''
as $$
  select g.* from public.games g
  order by (g.status = 'active') desc, g.started_at desc
  limit 1;
$$;
revoke execute on function public.message_game() from public, anon, authenticated;

-- For the host screen: how many people each choice would email.
-- Only confirmed email addresses count, so typo'd sign-ups aren't emailed.
create or replace function public.message_audience() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_game public.games;
begin
  perform public.assert_host();
  v_game := public.message_game();
  return jsonb_build_object(
    'everyone', (
      select count(*) from public.profiles p join auth.users u on u.id = p.id
      where u.email_confirmed_at is not null),
    'game', case when v_game.id is null then null else jsonb_build_object(
      'id', v_game.id, 'name', v_game.name, 'status', v_game.status,
      'count', (
        select count(*) from public.game_entries e
        join auth.users u on u.id = e.player_id
        where e.game_id = v_game.id and u.email_confirmed_at is not null)) end);
end;
$$;
revoke execute on function public.message_audience() from public, anon;
grant execute on function public.message_audience() to authenticated;

-- Who gets a message. 'game' = everyone entered in that game, knocked out or not.
-- Only the email function (service role) can call this, because it returns emails.
create or replace function public.message_targets(p_audience text, p_game_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_game public.games;
begin
  if p_audience = 'everyone' then
    return jsonb_build_object('game_name', null, 'players', (
      select coalesce(jsonb_agg(jsonb_build_object('email', p.email, 'name', p.display_name)
                                order by p.display_name), '[]'::jsonb)
      from public.profiles p join auth.users u on u.id = p.id
      where u.email_confirmed_at is not null));
  elsif p_audience = 'game' then
    select * into v_game from public.games where id = p_game_id;
    if not found then raise exception 'That game no longer exists. Refresh and try again.'; end if;
    return jsonb_build_object('game_name', v_game.name, 'players', (
      select coalesce(jsonb_agg(jsonb_build_object('email', p.email, 'name', p.display_name)
                                order by p.display_name), '[]'::jsonb)
      from public.game_entries e
      join public.profiles p on p.id = e.player_id
      join auth.users u on u.id = p.id
      where e.game_id = v_game.id and u.email_confirmed_at is not null));
  end if;
  raise exception 'Choose who to send the message to.';
end;
$$;
revoke execute on function public.message_targets(text, bigint) from public, anon, authenticated;
grant execute on function public.message_targets(text, bigint) to service_role;
