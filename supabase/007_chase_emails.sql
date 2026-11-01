-- =====================================================================
-- Last Person Standing - Stage 5: chase emails
-- Run AFTER 006_overview.sql.
-- =====================================================================

-- The link put in emails for {link}. The host screen fills this in automatically.
alter table public.email_settings add column if not exists pick_url text not null default '';

-- Who to chase right now: players still in who haven't picked for the open gameweek.
-- Returns no gameweek (with a reason) in a Week off, after the deadline, or with no game running.
-- Only the chase-emails Edge Function (service role) can call this, because it returns emails.
create or replace function public.chase_targets() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_gw public.gameweeks%rowtype;
begin
  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'open';
  if not found then return jsonb_build_object('gameweek', null, 'reason', 'No gameweek is open.'); end if;
  if v_gw.mode = 'off' then return jsonb_build_object('gameweek', null, 'reason', 'This is a week off.'); end if;
  if v_gw.deadline <= now() then return jsonb_build_object('gameweek', null, 'reason', 'The deadline has passed.'); end if;

  return jsonb_build_object(
    'gameweek', jsonb_build_object('id', v_gw.id, 'number', v_gw.number, 'deadline', v_gw.deadline),
    'players', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'name', p.display_name)
                                order by p.display_name), '[]'::jsonb)
      from public.game_entries e
      join public.profiles p on p.id = e.player_id
      where e.game_id = v_gw.game_id and e.status = 'alive'
        and not exists (
          select 1 from public.picks pk
          where pk.gameweek_id = v_gw.id and pk.player_id = e.player_id and pk.team_id is not null)));
end;
$$;

revoke execute on function public.chase_targets() from public, anon, authenticated;
grant execute on function public.chase_targets() to service_role;

-- For the host screen: chase emails sent for the open gameweek, counted per send,
-- plus how many players were emailed in the last hour (they won't be emailed again yet)
create or replace function public.email_log_summary() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_gw public.gameweeks%rowtype;
begin
  perform public.assert_host();
  select gw.* into v_gw
  from public.gameweeks gw join public.games g on g.id = gw.game_id
  where g.status = 'active' and gw.status = 'open';
  if not found then return jsonb_build_object('slots', '[]'::jsonb, 'recent_players', 0); end if;

  return jsonb_build_object(
    'slots', (
      select coalesce(jsonb_agg(jsonb_build_object('slot', s.slot, 'count', s.n, 'last_sent', s.last_sent)
                                order by s.last_sent desc), '[]'::jsonb)
      from (select slot, count(*) n, max(sent_at) last_sent
            from public.email_log where gameweek_id = v_gw.id group by slot) s),
    'recent_players', (
      select count(distinct player_id) from public.email_log
      where gameweek_id = v_gw.id and sent_at >= now() - interval '1 hour'));
end;
$$;

revoke execute on function public.email_log_summary() from public, anon;
grant execute on function public.email_log_summary() to authenticated;
