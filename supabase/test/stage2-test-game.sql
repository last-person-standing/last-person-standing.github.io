-- =====================================================================
-- TEST ONLY: sets up a pretend game so you can try the team picker
-- before the host tools exist (Stage 3). Run in Supabase SQL Editor.
--   * Gameweek 1 already played: everyone "won" with Arsenal
--     (so Arsenal shows as used/greyed out in the picker)
--   * Gameweek 2 open, deadline next Friday 5pm UK time
-- =====================================================================

insert into public.games (name) values ('Test game');

insert into public.gameweeks (game_id, number, deadline, status)
select id, 1, now() - interval '3 days', 'resulted' from public.games where name = 'Test game';

insert into public.gameweeks (game_id, number, deadline)
select id, 2, public.next_friday_deadline() from public.games where name = 'Test game';

insert into public.game_entries (game_id, player_id)
select g.id, p.id from public.games g cross join public.profiles p where g.name = 'Test game';

insert into public.picks (gameweek_id, game_id, player_id, team_id, result)
select gw.id, gw.game_id, e.player_id, (select id from public.teams where name = 'Arsenal'), 'won'
from public.gameweeks gw join public.game_entries e on e.game_id = gw.game_id
where gw.number = 1 and gw.game_id = (select id from public.games where name = 'Test game');


-- ---------------------------------------------------------------------
-- Extra tests (run one at a time, highlight just that line and Run):
-- ---------------------------------------------------------------------

-- Lock picks now (as if 5pm Friday has passed):
-- update public.gameweeks set deadline = now() - interval '1 minute' where number = 2 and game_id = (select id from public.games where name = 'Test game');

-- Unlock again (deadline back to next Friday 5pm):
-- update public.gameweeks set deadline = public.next_friday_deadline() where number = 2 and game_id = (select id from public.games where name = 'Test game');

-- Make it a Week off:
-- update public.gameweeks set mode = 'off' where number = 2 and game_id = (select id from public.games where name = 'Test game');

-- Make it a Custom week with just 4 teams allowed:
-- update public.gameweeks set mode = 'custom' where number = 2 and game_id = (select id from public.games where name = 'Test game');
-- insert into public.gameweek_teams (gameweek_id, team_id) select gw.id, t.id from public.gameweeks gw, public.teams t where gw.number = 2 and gw.game_id = (select id from public.games where name = 'Test game') and t.name in ('Chelsea', 'Wrexham', 'York City', 'Barnet');

-- Back to Normal:
-- update public.gameweeks set mode = 'normal' where number = 2 and game_id = (select id from public.games where name = 'Test game');
-- delete from public.gameweek_teams where gameweek_id = (select id from public.gameweeks where number = 2 and game_id = (select id from public.games where name = 'Test game'));

-- REMOVE the test game completely when you're done (deletes its weeks, entries and picks):
-- delete from public.games where name = 'Test game';
