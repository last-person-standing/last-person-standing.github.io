-- =====================================================================
-- Last Person Standing - double headers (two gameweeks open at once)
-- Run AFTER 010_deactivate_account.sql. Safe to run again.
--
-- A host can now open a second gameweek alongside the current one, e.g. the
-- weekend league round plus a Champions League night. Each gameweek keeps its
-- own deadline, picks and results. A player needs a winning pick in both to
-- stay in. The "each club once per game" rule is unchanged.
-- Nothing changes for a normal week with one gameweek open.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Table changes
-- ---------------------------------------------------------------------

-- When each gameweek was opened and confirmed. Used to work out which results
-- can still be undone now that gameweeks can overlap.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gameweeks' and column_name = 'opened_at'
  ) then
    alter table public.gameweeks add column opened_at   timestamptz not null default now();
    alter table public.gameweeks add column resulted_at timestamptz;
    -- Gameweeks that already exist were played one after another, so give the confirmed
    -- ones times in gameweek order (opened, then confirmed, then the next one opened).
    -- Only the order matters, not the actual times.
    update public.gameweeks
    set opened_at   = now() - interval '1 day' + number * interval '2 seconds',
        resulted_at = now() - interval '1 day' + number * interval '2 seconds' + interval '1 second'
    where status = 'resulted';
  end if;
end;
$$;

-- Up to two gameweeks may now be open in a game (the functions below enforce the limit)
drop index if exists public.gameweeks_one_open;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- An open gameweek of the running game: the one asked for, or the only one open
drop function if exists public.open_gameweek();
create or replace function public.open_gameweek(p_gameweek_id bigint default null) returns public.gameweeks
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_gw public.gameweeks%rowtype;
  v_n  int;
begin
  if p_gameweek_id is not null then
    select gw.* into v_gw
    from public.gameweeks gw join public.games g on g.id = gw.game_id
    where g.status = 'active' and gw.status = 'open' and gw.id = p_gameweek_id;
    if not found then raise exception 'That gameweek is no longer open. Tap Refresh.'; end if;
    return v_gw;
  end if;

  select count(*) into v_n
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'open';
  if v_n = 0 then raise exception 'There is no open gameweek. Start a game or the next gameweek first.'; end if;
  if v_n > 1 then raise exception 'Two gameweeks are open. Tap Refresh, then choose the gameweek first.'; end if;

  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'open';
  return v_gw;
end;
$$;

-- ---------------------------------------------------------------------
-- Players: picking
-- ---------------------------------------------------------------------

-- Make or change your pick. With two gameweeks open, say which one it is for.
drop function if exists public.make_pick(bigint);
create or replace function public.make_pick(p_team_id bigint, p_gameweek_id bigint default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_gw     public.gameweeks%rowtype;
  v_team   public.teams%rowtype;
  v_reopen timestamptz;
  v_n      int;
begin
  if v_uid is null then raise exception 'Please log in again.'; end if;

  if p_gameweek_id is not null then
    select gw.* into v_gw
    from public.gameweeks gw join public.games g on g.id = gw.game_id
    where g.status = 'active' and gw.status = 'open' and gw.id = p_gameweek_id;
    if not found then raise exception 'That gameweek is no longer open for picks. Please refresh the page.'; end if;
  else
    select count(*) into v_n
    from public.gameweeks gw join public.games g on g.id = gw.game_id
    where g.status = 'active' and gw.status = 'open';
    if v_n = 0 then raise exception 'There is no gameweek open for picks right now.'; end if;
    if v_n > 1 then raise exception 'Two gameweeks are open. Please refresh the page and choose which one this pick is for.'; end if;
    select gw.* into v_gw
    from public.gameweeks gw join public.games g on g.id = gw.game_id
    where g.status = 'active' and gw.status = 'open';
  end if;
  if v_gw.mode = 'off' then raise exception 'This is a week off, so no pick is needed.'; end if;

  if not exists (
    select 1 from public.game_entries e
    where e.game_id = v_gw.game_id and e.player_id = v_uid and e.status = 'alive'
  ) then
    raise exception 'You are not in this game, or you are already out.';
  end if;

  -- A host may have reopened this player's pick with a later deadline
  select p.reopen_deadline into v_reopen
  from public.picks p where p.gameweek_id = v_gw.id and p.player_id = v_uid;
  if now() >= coalesce(v_reopen, v_gw.deadline) then
    raise exception 'The deadline has passed, so picks are locked.';
  end if;

  select * into v_team from public.teams t where t.id = p_team_id;
  if not found then raise exception 'That team was not found.'; end if;

  if v_gw.mode = 'custom' then
    if not exists (
      select 1 from public.gameweek_teams gt where gt.gameweek_id = v_gw.id and gt.team_id = p_team_id
    ) then
      raise exception '% is not one of the teams allowed this week.', v_team.name;
    end if;
  elsif not v_team.active or v_team.league = 'NL' then
    raise exception '% is not available.', v_team.name;
  end if;

  if exists (
    select 1 from public.picks p
    where p.game_id = v_gw.game_id and p.player_id = v_uid
      and p.team_id = p_team_id and p.gameweek_id <> v_gw.id
  ) then
    raise exception 'You have already used % in this game.', v_team.name;
  end if;

  insert into public.picks (gameweek_id, game_id, player_id, team_id, set_by, updated_at)
  values (v_gw.id, v_gw.game_id, v_uid, p_team_id, v_uid, now())
  on conflict (gameweek_id, player_id)
  do update set team_id = excluded.team_id, result = 'pending', set_by = excluded.set_by, updated_at = now();
end;
$$;

-- Everything the pick page needs about the logged-in player, in one call.
-- With two gameweeks open, 'rounds' lists both and the rest describes one of them:
-- the one asked for, otherwise the first that still needs this player's pick.
drop function if exists public.my_game_state();
create or replace function public.my_game_state(p_gameweek_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_game     public.games%rowtype;
  v_gw       public.gameweeks%rowtype;
  v_entry    public.game_entries%rowtype;
  v_pick     public.picks%rowtype;
  v_deadline timestamptz;
begin
  if v_uid is null then raise exception 'Please log in again.'; end if;

  select * into v_game from public.games where status = 'active';
  if not found then
    return jsonb_build_object('now', now(), 'game', null);
  end if;

  select * into v_entry from public.game_entries where game_id = v_game.id and player_id = v_uid;

  if p_gameweek_id is not null then
    select * into v_gw from public.gameweeks
    where id = p_gameweek_id and game_id = v_game.id and status = 'open';
  end if;
  if v_gw.id is null then
    -- An open gameweek that still needs this player's pick, then one that hasn't locked,
    -- then any open one, then the most recent
    select gw.* into v_gw
    from public.gameweeks gw
    left join public.picks p on p.gameweek_id = gw.id and p.player_id = v_uid
    where gw.game_id = v_game.id
    order by (gw.status = 'open') desc,
             (gw.status = 'open' and gw.mode <> 'off' and p.team_id is null
              and now() < coalesce(p.reopen_deadline, gw.deadline)) desc,
             (gw.status = 'open' and gw.mode <> 'off'
              and now() < coalesce(p.reopen_deadline, gw.deadline)) desc,
             case when gw.status = 'open' then gw.number end asc,
             gw.number desc
    limit 1;
  end if;

  if v_gw.id is not null then
    select * into v_pick from public.picks where gameweek_id = v_gw.id and player_id = v_uid;
    v_deadline := coalesce(v_pick.reopen_deadline, v_gw.deadline);
  end if;

  return jsonb_build_object(
    'now', now(),   -- server time, so the countdown isn't fooled by a wrong phone clock
    'game', jsonb_build_object('id', v_game.id, 'name', v_game.name),
    'entry_status', v_entry.status,   -- 'alive' | 'out' | 'winner' | null (not entered)
    'gameweek', case when v_gw.id is null then null else jsonb_build_object(
      'id', v_gw.id, 'number', v_gw.number, 'mode', v_gw.mode,
      'status', v_gw.status, 'deadline', v_gw.deadline) end,
    'deadline', v_deadline,           -- this player's deadline (later if reopened)
    'reopened', v_pick.reopen_deadline is not null,
    'can_pick', coalesce(
      v_entry.status = 'alive' and v_gw.status = 'open' and v_gw.mode <> 'off' and now() < v_deadline,
      false),
    'pick_team_id', v_pick.team_id,
    'allowed_team_ids', case when v_gw.mode = 'custom' then (
      select coalesce(jsonb_agg(gt.team_id), '[]'::jsonb)
      from public.gameweek_teams gt where gt.gameweek_id = v_gw.id) end,
    'used_team_ids', (
      select coalesce(jsonb_agg(p.team_id), '[]'::jsonb)
      from public.picks p
      where p.game_id = v_game.id and p.player_id = v_uid
        and p.team_id is not null and p.gameweek_id is distinct from v_gw.id),
    'run', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'number', g.number, 'mode', g.mode, 'status', g.status,
               'team_id', p.team_id, 'result', p.result) order by g.number), '[]'::jsonb)
      from public.gameweeks g
      left join public.picks p on p.gameweek_id = g.id and p.player_id = v_uid
      where g.game_id = v_game.id),
    -- every open gameweek, with this player's pick and own deadline in each
    'rounds', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', g.id, 'number', g.number, 'mode', g.mode,
               'deadline', coalesce(p.reopen_deadline, g.deadline),
               'pick_team_id', p.team_id,
               'can_pick', coalesce(v_entry.status = 'alive' and g.mode <> 'off'
                                    and now() < coalesce(p.reopen_deadline, g.deadline), false))
             order by g.number), '[]'::jsonb)
      from public.gameweeks g
      left join public.picks p on p.gameweek_id = g.id and p.player_id = v_uid
      where g.game_id = v_game.id and g.status = 'open')
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Host: gameweeks
-- ---------------------------------------------------------------------

-- Open the next gameweek. Normally only after the current one's results are confirmed.
-- With p_alongside = true it opens next to the one gameweek already open (a double header).
drop function if exists public.host_next_gameweek(text, timestamptz);
create or replace function public.host_next_gameweek(
  p_mode text default 'normal', p_deadline timestamptz default null, p_alongside boolean default false)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_game     bigint;
  v_number   int;
  v_deadline timestamptz := coalesce(p_deadline, public.next_friday_deadline());
  v_id       bigint;
  v_open     int;
begin
  perform public.assert_host();
  select id into v_game from public.games where status = 'active';
  if not found then raise exception 'No game is running.'; end if;

  select count(*) into v_open from public.gameweeks where game_id = v_game and status = 'open';
  if v_open >= 2 then
    raise exception 'Two gameweeks are already open. Confirm the results for one of them first.';
  end if;
  if v_open = 1 and not coalesce(p_alongside, false) then
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

-- Change an open gameweek's type, deadline and (for Custom) allowed teams, before its deadline.
drop function if exists public.host_update_gameweek(text, timestamptz, bigint[]);
create or replace function public.host_update_gameweek(
  p_mode text, p_deadline timestamptz default null, p_team_ids bigint[] default null,
  p_gameweek_id bigint default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw      public.gameweeks%rowtype;
  v_removed int := 0;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek(p_gameweek_id);
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
-- Host: picks
-- ---------------------------------------------------------------------

drop function if exists public.host_set_pick(uuid, bigint);
create or replace function public.host_set_pick(p_player uuid, p_team_id bigint, p_gameweek_id bigint default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw   public.gameweeks%rowtype;
  v_name text;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek(p_gameweek_id);
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

drop function if exists public.host_reopen_picks(uuid[], timestamptz);
create or replace function public.host_reopen_picks(
  p_player_ids uuid[], p_deadline timestamptz, p_gameweek_id bigint default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw    public.gameweeks%rowtype;
  v_count int;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek(p_gameweek_id);
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
-- Host: results
-- ---------------------------------------------------------------------

drop function if exists public.host_set_team_result(bigint, text);
create or replace function public.host_set_team_result(p_team_id bigint, p_result text, p_gameweek_id bigint default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_gw    public.gameweeks%rowtype;
  v_count int;
begin
  perform public.assert_host();
  v_gw := public.open_gameweek(p_gameweek_id);
  if p_result not in ('won', 'lost', 'pending') then raise exception 'Result must be won, lost or pending.'; end if;
  update public.picks set result = p_result, updated_at = now()
  where gameweek_id = v_gw.id and team_id = p_team_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Confirm a gameweek: everyone still in without a winning pick in it (lost, or no pick) is out.
-- Only players still in are checked, so someone already knocked out by the other
-- gameweek of a double header can't hold this one up.
drop function if exists public.host_confirm_results();
create or replace function public.host_confirm_results(p_gameweek_id bigint default null)
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
  v_gw := public.open_gameweek(p_gameweek_id);
  if v_gw.deadline > now() then raise exception 'The deadline hasn''t passed yet.'; end if;

  if v_gw.mode <> 'off' then
    select count(distinct p.team_id) into v_pending
    from public.picks p
    join public.game_entries e
      on e.game_id = p.game_id and e.player_id = p.player_id and e.status = 'alive'
    where p.gameweek_id = v_gw.id and p.team_id is not null and p.result = 'pending';
    if v_pending > 0 then
      raise exception 'Mark every team green or red first (% still to do).', v_pending;
    end if;

    select max(p.reopen_deadline) into v_open
    from public.picks p
    join public.game_entries e
      on e.game_id = p.game_id and e.player_id = p.player_id and e.status = 'alive'
    where p.gameweek_id = v_gw.id and p.team_id is null and p.reopen_deadline > now();
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

  update public.gameweeks set status = 'resulted', resulted_at = now() where id = v_gw.id;

  return jsonb_build_object(
    'out', v_out,
    'still_in', (select count(*) from public.game_entries where game_id = v_gw.game_id and status = 'alive'));
end;
$$;

-- Undo the most recently confirmed results (if a mistake was made).
-- Only before another gameweek is opened. In a double header, undo in reverse order.
drop function if exists public.host_undo_results();
create or replace function public.host_undo_results(p_gameweek_id bigint default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_gw public.gameweeks%rowtype;
begin
  perform public.assert_host();
  if not exists (select 1 from public.games where status = 'active') then
    raise exception 'No game is running.';
  end if;

  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'resulted'
  order by gw.resulted_at desc nulls last, gw.number desc limit 1;
  if not found then raise exception 'There are no confirmed results to undo.'; end if;

  if p_gameweek_id is not null and p_gameweek_id <> v_gw.id then
    raise exception 'Only the most recently confirmed gameweek can be undone (Gameweek %).', v_gw.number;
  end if;
  if exists (
    select 1 from public.gameweeks o
    where o.game_id = v_gw.game_id and o.id <> v_gw.id and o.opened_at > v_gw.resulted_at
  ) then
    raise exception 'Only the latest confirmed gameweek can be undone, and only before the next one is opened.';
  end if;

  update public.game_entries set status = 'alive', out_gameweek_id = null
  where game_id = v_gw.game_id and out_gameweek_id = v_gw.id;
  update public.gameweeks set status = 'open', resulted_at = null where id = v_gw.id;
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
  update public.gameweeks set status = 'resulted', resulted_at = now() where game_id = v_game and status = 'open';
  update public.games
  set status = 'finished', ended_at = now(), winner_note = nullif(trim(p_note), '')
  where id = v_game;
end;
$$;

-- ---------------------------------------------------------------------
-- Chase emails
-- ---------------------------------------------------------------------

-- Who to chase right now: players still in who are missing a pick in any open gameweek
-- that hasn't locked yet. Each player comes with the gameweek(s) they still need
-- (e.g. '7' or '7 and 8') and their earliest deadline, for the email wording.
create or replace function public.chase_targets() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_game bigint;
  v_gw   public.gameweeks%rowtype;
begin
  select id into v_game from public.games where status = 'active';
  if not exists (select 1 from public.gameweeks where game_id = v_game and status = 'open') then
    return jsonb_build_object('gameweek', null, 'reason', 'No gameweek is open.');
  end if;
  if not exists (select 1 from public.gameweeks where game_id = v_game and status = 'open' and mode <> 'off') then
    return jsonb_build_object('gameweek', null, 'reason', 'This is a week off.');
  end if;

  -- The next gameweek to lock (emails are logged against this one)
  select * into v_gw from public.gameweeks
  where game_id = v_game and status = 'open' and mode <> 'off' and deadline > now()
  order by deadline, number limit 1;
  if not found then return jsonb_build_object('gameweek', null, 'reason', 'The deadline has passed.'); end if;

  return jsonb_build_object(
    'gameweek', jsonb_build_object('id', v_gw.id, 'number', v_gw.number, 'deadline', v_gw.deadline),
    'players', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', m.id, 'email', m.email, 'name', m.name,
               'gameweek', m.gameweek, 'deadline', m.deadline) order by m.name), '[]'::jsonb)
      from (
        select p.id, p.email, p.display_name as name,
               string_agg(gw.number::text, ' and ' order by gw.number) as gameweek,
               min(gw.deadline) as deadline
        from public.game_entries e
        join public.profiles p on p.id = e.player_id
        join public.gameweeks gw
          on gw.game_id = e.game_id and gw.status = 'open' and gw.mode <> 'off' and gw.deadline > now()
        where e.game_id = v_game and e.status = 'alive'
          and not exists (
            select 1 from public.picks pk
            where pk.gameweek_id = gw.id and pk.player_id = e.player_id and pk.team_id is not null)
        group by p.id, p.email, p.display_name) m));
end;
$$;

-- For the host screen: chase emails sent for the open gameweek(s), counted per send,
-- plus how many players were emailed in the last hour (they won't be emailed again yet)
create or replace function public.email_log_summary() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.assert_host();
  if not exists (
    select 1 from public.gameweeks gw join public.games g on g.id = gw.game_id
    where g.status = 'active' and gw.status = 'open'
  ) then
    return jsonb_build_object('slots', '[]'::jsonb, 'recent_players', 0);
  end if;

  return jsonb_build_object(
    'slots', (
      select coalesce(jsonb_agg(jsonb_build_object('slot', s.slot, 'count', s.n, 'last_sent', s.last_sent)
                                order by s.last_sent desc), '[]'::jsonb)
      from (select l.slot, count(*) n, max(l.sent_at) last_sent
            from public.email_log l
            join public.gameweeks gw on gw.id = l.gameweek_id
            join public.games g on g.id = gw.game_id
            where g.status = 'active' and gw.status = 'open'
            group by l.slot) s),
    'recent_players', (
      select count(distinct l.player_id)
      from public.email_log l
      join public.gameweeks gw on gw.id = l.gameweek_id
      join public.games g on g.id = gw.game_id
      where g.status = 'active' and gw.status = 'open' and l.sent_at >= now() - interval '1 hour'));
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions (the changed functions are new to the database, so set them again)
-- ---------------------------------------------------------------------
revoke execute on function public.open_gameweek(bigint) from public, anon, authenticated;

revoke execute on function public.make_pick(bigint, bigint) from public, anon;
revoke execute on function public.my_game_state(bigint) from public, anon;
revoke execute on function public.host_next_gameweek(text, timestamptz, boolean) from public, anon;
revoke execute on function public.host_update_gameweek(text, timestamptz, bigint[], bigint) from public, anon;
revoke execute on function public.host_set_pick(uuid, bigint, bigint) from public, anon;
revoke execute on function public.host_reopen_picks(uuid[], timestamptz, bigint) from public, anon;
revoke execute on function public.host_set_team_result(bigint, text, bigint) from public, anon;
revoke execute on function public.host_confirm_results(bigint) from public, anon;
revoke execute on function public.host_undo_results(bigint) from public, anon;

grant execute on function public.make_pick(bigint, bigint) to authenticated;
grant execute on function public.my_game_state(bigint) to authenticated;
grant execute on function public.host_next_gameweek(text, timestamptz, boolean) to authenticated;
grant execute on function public.host_update_gameweek(text, timestamptz, bigint[], bigint) to authenticated;
grant execute on function public.host_set_pick(uuid, bigint, bigint) to authenticated;
grant execute on function public.host_reopen_picks(uuid[], timestamptz, bigint) to authenticated;
grant execute on function public.host_set_team_result(bigint, text, bigint) to authenticated;
grant execute on function public.host_confirm_results(bigint) to authenticated;
grant execute on function public.host_undo_results(bigint) to authenticated;

-- Tell the API about the changed functions straight away
notify pgrst, 'reload schema';
