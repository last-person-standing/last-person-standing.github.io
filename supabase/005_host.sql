-- =====================================================================
-- Last Person Standing - Stage 3: host tools
-- Run AFTER 004_picks.sql.
-- Every function checks the caller is a host before doing anything.
-- =====================================================================

create or replace function public.assert_host() returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_host() then raise exception 'Only hosts can do this.'; end if;
end;
$$;

-- The open gameweek of the running game (errors if there isn't one)
create or replace function public.open_gameweek() returns public.gameweeks
language plpgsql stable security definer set search_path = ''
as $$
declare v_gw public.gameweeks%rowtype;
begin
  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'open';
  if not found then raise exception 'There is no open gameweek. Start a game or the next gameweek first.'; end if;
  return v_gw;
end;
$$;

-- Is this team allowed in this gameweek? (shared by host overrides)
create or replace function public.team_allowed(p_gw public.gameweeks, p_team_id bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_gw.mode = 'custom' then exists (
      select 1 from public.gameweek_teams gt where gt.gameweek_id = p_gw.id and gt.team_id = p_team_id)
    else exists (
      select 1 from public.teams t where t.id = p_team_id and t.active and t.league <> 'NL')
  end;
$$;

-- ---------------------------------------------------------------------
-- Players and credit
-- ---------------------------------------------------------------------

-- Add (or, with a negative number, remove) games of credit
create or replace function public.host_add_credit(p_player uuid, p_change int, p_reason text default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_credit int;
begin
  perform public.assert_host();
  if coalesce(p_change, 0) = 0 then raise exception 'Enter a number of games other than 0.'; end if;

  select credit into v_credit from public.profiles where id = p_player for update;
  if not found then raise exception 'Player not found.'; end if;
  if v_credit + p_change < 0 then
    raise exception 'They only have % game(s) of credit.', v_credit;
  end if;

  update public.profiles set credit = credit + p_change where id = p_player
  returning credit into v_credit;

  insert into public.credit_log (player_id, change, reason, by_user)
  values (p_player, p_change,
          coalesce(nullif(trim(p_reason), ''), case when p_change > 0 then 'Payment received' else 'Correction' end),
          auth.uid());
  return v_credit;
end;
$$;

-- Make another player a host, or back to a player
create or replace function public.host_set_role(p_player uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.assert_host();
  if p_role not in ('player', 'host') then raise exception 'Role must be player or host.'; end if;
  if p_role = 'player'
     and (select count(*) from public.profiles where role = 'host' and id <> p_player) = 0 then
    raise exception 'There must always be at least one host.';
  end if;
  update public.profiles set role = p_role where id = p_player;
  if not found then raise exception 'Player not found.'; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------

-- Start a new game: everyone with credit is entered and 1 credit is taken.
create or replace function public.host_start_game(p_name text, p_first_deadline timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_game     bigint;
  v_deadline timestamptz := coalesce(p_first_deadline, public.next_friday_deadline());
  v_entered  int;
begin
  perform public.assert_host();
  if exists (select 1 from public.games where status = 'active') then
    raise exception 'A game is already running. End it before starting a new one.';
  end if;
  if v_deadline <= now() then raise exception 'The first deadline must be in the future.'; end if;

  begin
    insert into public.games (name)
    values (coalesce(nullif(trim(p_name), ''), 'Game starting ' || to_char(v_deadline at time zone 'Europe/London', 'DD Mon YYYY')))
    returning id into v_game;
  exception when unique_violation then
    raise exception 'A game is already running. End it before starting a new one.';
  end;

  insert into public.gameweeks (game_id, number, deadline) values (v_game, 1, v_deadline);

  with paid as (
    update public.profiles set credit = credit - 1 where credit >= 1 returning id
  ), entered as (
    insert into public.game_entries (game_id, player_id) select v_game, id from paid returning player_id
  ), logged as (
    insert into public.credit_log (player_id, change, reason, game_id, by_user)
    select player_id, -1, 'Entered game', v_game, auth.uid() from entered returning 1
  )
  select count(*) into v_entered from logged;

  return jsonb_build_object(
    'game_id', v_game,
    'entered', v_entered,
    'awaiting', (select count(*) from public.profiles p
                 where not exists (select 1 from public.game_entries e where e.game_id = v_game and e.player_id = p.id)));
end;
$$;

-- Add one player to the running game (e.g. paid after it started). Takes 1 credit.
create or replace function public.host_enter_player(p_player uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_game bigint; v_credit int;
begin
  perform public.assert_host();
  select id into v_game from public.games where status = 'active';
  if not found then raise exception 'No game is running.'; end if;
  if exists (select 1 from public.game_entries where game_id = v_game and player_id = p_player) then
    raise exception 'They are already in this game.';
  end if;
  select credit into v_credit from public.profiles where id = p_player for update;
  if not found then raise exception 'Player not found.'; end if;
  if v_credit < 1 then raise exception 'They have no credit. Add credit first.'; end if;

  update public.profiles set credit = credit - 1 where id = p_player;
  insert into public.game_entries (game_id, player_id) values (v_game, p_player);
  insert into public.credit_log (player_id, change, reason, game_id, by_user)
  values (p_player, -1, 'Entered game', v_game, auth.uid());
end;
$$;

-- Take a player out of the running game entirely (a mistake), optionally refunding the credit
create or replace function public.host_remove_player(p_player uuid, p_refund boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_game bigint;
begin
  perform public.assert_host();
  select id into v_game from public.games where status = 'active';
  if not found then raise exception 'No game is running.'; end if;
  delete from public.game_entries where game_id = v_game and player_id = p_player;
  if not found then raise exception 'They are not in this game.'; end if;
  delete from public.picks where game_id = v_game and player_id = p_player;
  if p_refund then
    update public.profiles set credit = credit + 1 where id = p_player;
    insert into public.credit_log (player_id, change, reason, game_id, by_user)
    values (p_player, 1, 'Refund: removed from game', v_game, auth.uid());
  end if;
end;
$$;

-- End the running game and record the winner(s)
create or replace function public.host_end_game(p_winner_ids uuid[] default '{}', p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_game bigint;
begin
  perform public.assert_host();
  select id into v_game from public.games where status = 'active';
  if not found then raise exception 'No game is running.'; end if;

  update public.game_entries set status = 'winner'
  where game_id = v_game and player_id = any(coalesce(p_winner_ids, '{}'));
  update public.gameweeks set status = 'resulted' where game_id = v_game and status = 'open';
  update public.games
  set status = 'finished', ended_at = now(), winner_note = nullif(trim(p_note), '')
  where id = v_game;
end;
$$;

-- ---------------------------------------------------------------------
-- Gameweeks
-- ---------------------------------------------------------------------

-- Open the next gameweek (after the last one's results are confirmed)
create or replace function public.host_next_gameweek(p_mode text default 'normal', p_deadline timestamptz default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_game     bigint;
  v_number   int;
  v_deadline timestamptz := coalesce(p_deadline, public.next_friday_deadline());
  v_id       bigint;
begin
  perform public.assert_host();
  select id into v_game from public.games where status = 'active';
  if not found then raise exception 'No game is running.'; end if;
  if exists (select 1 from public.gameweeks where game_id = v_game and status = 'open') then
    raise exception 'Confirm the results for the current gameweek first.';
  end if;
  if not exists (select 1 from public.game_entries where game_id = v_game and status = 'alive') then
    raise exception 'Nobody is left in. End the game instead.';
  end if;
  if p_mode not in ('normal', 'off', 'custom') then raise exception 'Unknown week type.'; end if;
  if v_deadline <= now() then raise exception 'The deadline must be in the future.'; end if;

  select coalesce(max(number), 0) + 1 into v_number from public.gameweeks where game_id = v_game;
  begin
    insert into public.gameweeks (game_id, number, mode, deadline)
    values (v_game, v_number, p_mode, v_deadline)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'The next gameweek has already been opened.';
  end;
  return v_id;
end;
$$;

-- Change the open gameweek's type, deadline and (for Custom) allowed teams, before its deadline.
-- Any picks that are no longer allowed (e.g. everything in a Week off) are removed,
-- so those players pick again and don't lose the team.
create or replace function public.host_update_gameweek(
  p_mode text, p_deadline timestamptz default null, p_team_ids bigint[] default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw      public.gameweeks%rowtype;
  v_removed int := 0;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek();
  if p_mode not in ('normal', 'off', 'custom') then raise exception 'Unknown week type.'; end if;
  if now() >= v_gw.deadline then
    raise exception 'The deadline has passed, so the week can''t be changed. Use "Reopen" for postponed matches.';
  end if;
  if p_deadline is not null and p_deadline <= now() then
    raise exception 'The new deadline must be in the future.';
  end if;

  update public.gameweeks
  set mode = p_mode, deadline = coalesce(p_deadline, deadline)
  where id = v_gw.id
  returning * into v_gw;

  if p_mode = 'custom' and p_team_ids is not null then
    delete from public.gameweek_teams where gameweek_id = v_gw.id;
    insert into public.gameweek_teams (gameweek_id, team_id)
    select distinct v_gw.id, t.id from public.teams t where t.id = any(p_team_ids);
  end if;

  delete from public.picks p
  where p.gameweek_id = v_gw.id
    and (v_gw.mode = 'off' or p.team_id is null or not public.team_allowed(v_gw, p.team_id));
  get diagnostics v_removed = row_count;

  return jsonb_build_object(
    'removed_picks', v_removed,
    'custom_teams', (select count(*) from public.gameweek_teams where gameweek_id = v_gw.id));
end;
$$;

-- ---------------------------------------------------------------------
-- Picks: overrides and postponements
-- ---------------------------------------------------------------------

-- Add, change or (with null) remove a pick for any player still in. Ignores the deadline.
create or replace function public.host_set_pick(p_player uuid, p_team_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw   public.gameweeks%rowtype;
  v_name text;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek();
  if v_gw.mode = 'off' then raise exception 'This is a week off, so no picks are needed.'; end if;
  if not exists (
    select 1 from public.game_entries
    where game_id = v_gw.game_id and player_id = p_player and status = 'alive'
  ) then
    raise exception 'That player is not still in this game.';
  end if;

  if p_team_id is null then
    delete from public.picks where gameweek_id = v_gw.id and player_id = p_player;
    return;
  end if;

  select name into v_name from public.teams where id = p_team_id;
  if v_name is null then raise exception 'That team was not found.'; end if;
  if not public.team_allowed(v_gw, p_team_id) then
    raise exception '% is not available this week.', v_name;
  end if;
  if exists (
    select 1 from public.picks
    where game_id = v_gw.game_id and player_id = p_player and team_id = p_team_id and gameweek_id <> v_gw.id
  ) then
    raise exception 'They have already used % in this game.', v_name;
  end if;

  insert into public.picks (gameweek_id, game_id, player_id, team_id, set_by, updated_at)
  values (v_gw.id, v_gw.game_id, p_player, p_team_id, auth.uid(), now())
  on conflict (gameweek_id, player_id) do update
  set team_id = excluded.team_id, result = 'pending', reopen_deadline = null,
      set_by = excluded.set_by, updated_at = now();
end;
$$;

-- Postponed / abandoned match: clear these players' picks so they can pick again
-- before a new deadline. Their old team is given back (it doesn't count as used).
create or replace function public.host_reopen_picks(p_player_ids uuid[], p_deadline timestamptz)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw    public.gameweeks%rowtype;
  v_count int;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek();
  if v_gw.mode = 'off' then raise exception 'This is a week off.'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'The new deadline must be in the future.'; end if;

  insert into public.picks (gameweek_id, game_id, player_id, team_id, result, reopen_deadline, set_by, updated_at)
  select v_gw.id, v_gw.game_id, e.player_id, null, 'pending', p_deadline, auth.uid(), now()
  from public.game_entries e
  where e.game_id = v_gw.game_id and e.status = 'alive' and e.player_id = any(coalesce(p_player_ids, '{}'))
  on conflict (gameweek_id, player_id) do update
  set team_id = null, result = 'pending', reopen_deadline = excluded.reopen_deadline,
      set_by = excluded.set_by, updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------

-- Mark a team green (won), red (lost) or back to pending for the open gameweek
create or replace function public.host_set_team_result(p_team_id bigint, p_result text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw    public.gameweeks%rowtype;
  v_count int;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek();
  if p_result not in ('won', 'lost', 'pending') then raise exception 'Result must be won, lost or pending.'; end if;
  update public.picks set result = p_result, updated_at = now()
  where gameweek_id = v_gw.id and team_id = p_team_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Confirm the week: everyone still in without a winning pick (lost, or no pick) is out.
create or replace function public.host_confirm_results()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw      public.gameweeks%rowtype;
  v_pending int;
  v_open    timestamptz;
  v_out     int := 0;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek();
  if v_gw.deadline > now() then raise exception 'The deadline hasn''t passed yet.'; end if;

  if v_gw.mode <> 'off' then
    select count(distinct team_id) into v_pending
    from public.picks where gameweek_id = v_gw.id and team_id is not null and result = 'pending';
    if v_pending > 0 then
      raise exception 'Mark every team green or red first (% still to do).', v_pending;
    end if;

    select max(reopen_deadline) into v_open
    from public.picks where gameweek_id = v_gw.id and team_id is null and reopen_deadline > now();
    if v_open is not null then
      raise exception 'Some reopened picks are still open until %.',
        to_char(v_open at time zone 'Europe/London', 'Dy DD Mon HH24:MI');
    end if;

    update public.game_entries e
    set status = 'out', out_gameweek_id = v_gw.id
    where e.game_id = v_gw.game_id and e.status = 'alive'
      and not exists (
        select 1 from public.picks p
        where p.gameweek_id = v_gw.id and p.player_id = e.player_id and p.result = 'won');
    get diagnostics v_out = row_count;
  end if;

  update public.gameweeks set status = 'resulted' where id = v_gw.id;

  return jsonb_build_object(
    'out', v_out,
    'still_in', (select count(*) from public.game_entries where game_id = v_gw.game_id and status = 'alive'));
end;
$$;

-- Undo the most recent confirmed results (if a mistake was made)
create or replace function public.host_undo_results()
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_gw public.gameweeks%rowtype;
begin
  perform public.assert_host();
  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active'
  order by gw.number desc limit 1;
  if not found then raise exception 'No game is running.'; end if;
  if v_gw.status <> 'resulted' then
    raise exception 'Only the latest confirmed gameweek can be undone, and only before the next one is opened.';
  end if;
  update public.game_entries set status = 'alive', out_gameweek_id = null
  where game_id = v_gw.game_id and out_gameweek_id = v_gw.id;
  update public.gameweeks set status = 'open' where id = v_gw.id;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions: helpers are internal; host functions need a logged-in user
-- (and then check for host themselves)
-- ---------------------------------------------------------------------
revoke execute on function public.assert_host() from public, anon, authenticated;
revoke execute on function public.open_gameweek() from public, anon, authenticated;
revoke execute on function public.team_allowed(public.gameweeks, bigint) from public, anon, authenticated;

revoke execute on function public.host_add_credit(uuid, int, text) from public, anon;
revoke execute on function public.host_set_role(uuid, text) from public, anon;
revoke execute on function public.host_start_game(text, timestamptz) from public, anon;
revoke execute on function public.host_enter_player(uuid) from public, anon;
revoke execute on function public.host_remove_player(uuid, boolean) from public, anon;
revoke execute on function public.host_end_game(uuid[], text) from public, anon;
revoke execute on function public.host_next_gameweek(text, timestamptz) from public, anon;
revoke execute on function public.host_update_gameweek(text, timestamptz, bigint[]) from public, anon;
revoke execute on function public.host_set_pick(uuid, bigint) from public, anon;
revoke execute on function public.host_reopen_picks(uuid[], timestamptz) from public, anon;
revoke execute on function public.host_set_team_result(bigint, text) from public, anon;
revoke execute on function public.host_confirm_results() from public, anon;
revoke execute on function public.host_undo_results() from public, anon;

grant execute on function public.host_add_credit(uuid, int, text) to authenticated;
grant execute on function public.host_set_role(uuid, text) to authenticated;
grant execute on function public.host_start_game(text, timestamptz) to authenticated;
grant execute on function public.host_enter_player(uuid) to authenticated;
grant execute on function public.host_remove_player(uuid, boolean) to authenticated;
grant execute on function public.host_end_game(uuid[], text) to authenticated;
grant execute on function public.host_next_gameweek(text, timestamptz) to authenticated;
grant execute on function public.host_update_gameweek(text, timestamptz, bigint[]) to authenticated;
grant execute on function public.host_set_pick(uuid, bigint) to authenticated;
grant execute on function public.host_reopen_picks(uuid[], timestamptz) to authenticated;
grant execute on function public.host_set_team_result(bigint, text) to authenticated;
grant execute on function public.host_confirm_results() to authenticated;
grant execute on function public.host_undo_results() to authenticated;
