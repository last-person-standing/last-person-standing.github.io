-- =====================================================================
-- Last Person Standing - Stage 2: making picks
-- Run AFTER 003_signup_payment.sql.
-- =====================================================================

-- Make or change your pick for the current gameweek.
-- All the game rules are checked here, so they can't be skipped from the browser.
create or replace function public.make_pick(p_team_id bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_gw     public.gameweeks%rowtype;
  v_team   public.teams%rowtype;
  v_reopen timestamptz;
begin
  if v_uid is null then raise exception 'Please log in again.'; end if;

  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'open';
  if not found then raise exception 'There is no gameweek open for picks right now.'; end if;
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

-- Everything the pick page needs about the logged-in player, in one call
create or replace function public.my_game_state() returns jsonb
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

  -- Current gameweek: the open one, otherwise the most recent
  select * into v_gw from public.gameweeks
  where game_id = v_game.id
  order by (status = 'open') desc, number desc
  limit 1;

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
      where g.game_id = v_game.id)
  );
end;
$$;

-- Only logged-in users may call these
revoke execute on function public.make_pick(bigint) from public, anon;
revoke execute on function public.my_game_state() from public, anon;
grant execute on function public.make_pick(bigint) to authenticated;
grant execute on function public.my_game_state() to authenticated;
