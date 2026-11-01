-- =====================================================================
-- Last Person Standing - Stage 4: overview (everyone's runs)
-- Run AFTER 005_host.sql.
-- =====================================================================

-- Everything the overview page needs, for the running game (or a past game by id).
-- Picks only appear once their deadline has passed (and any reopened re-pick deadline),
-- so nobody can see this week's picks before 5pm Friday. Emails are never included.
create or replace function public.overview_data(p_game_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_game public.games%rowtype;
begin
  if auth.uid() is null then raise exception 'Please log in again.'; end if;

  if p_game_id is null then
    select * into v_game from public.games
    order by (status = 'active') desc, started_at desc limit 1;
  else
    select * into v_game from public.games where id = p_game_id;
  end if;
  if not found then return jsonb_build_object('game', null, 'games', '[]'::jsonb); end if;

  return jsonb_build_object(
    'now', now(),
    'game', jsonb_build_object('id', v_game.id, 'name', v_game.name, 'status', v_game.status,
                               'started_at', v_game.started_at, 'ended_at', v_game.ended_at,
                               'winner_note', v_game.winner_note),
    -- every game, for a "past games" picker
    'games', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'status', g.status)
                                        order by g.started_at desc), '[]'::jsonb)
              from public.games g),
    'gameweeks', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', gw.id, 'number', gw.number, 'mode', gw.mode, 'status', gw.status,
               'deadline', gw.deadline, 'revealed', gw.deadline <= now()) order by gw.number), '[]'::jsonb)
      from public.gameweeks gw where gw.game_id = v_game.id),
    'players', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.player_id, 'name', p.display_name, 'status', e.status,
               'out_gameweek', ogw.number) order by p.display_name), '[]'::jsonb)
      from public.game_entries e
      join public.profiles p on p.id = e.player_id
      left join public.gameweeks ogw on ogw.id = e.out_gameweek_id
      where e.game_id = v_game.id),
    'picks', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'player_id', pk.player_id, 'gameweek', gw.number,
               'team_id', pk.team_id, 'result', pk.result)), '[]'::jsonb)
      from public.picks pk
      join public.gameweeks gw on gw.id = pk.gameweek_id
      where pk.game_id = v_game.id
        and gw.deadline <= now()
        and (pk.reopen_deadline is null or pk.reopen_deadline <= now()))
  );
end;
$$;

revoke execute on function public.overview_data(bigint) from public, anon;
grant execute on function public.overview_data(bigint) to authenticated;
