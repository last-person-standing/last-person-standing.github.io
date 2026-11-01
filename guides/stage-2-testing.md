# Stage 2: testing the team picker

Do Stage 1 setup first (`guides/stage-1-setup.md`).

## Setup (5 minutes)

1. Supabase → **SQL Editor** → **New query** → paste all of `supabase/004_picks.sql` → **Run**.
2. New query → paste all of `supabase/test/stage2-test-game.sql` → **Run**.
   This creates a pretend game: Gameweek 1 is already played (everyone "won" with Arsenal), and Gameweek 2 is open until next Friday 5pm.
   The lines starting `--` don't run. They're extra tests you'll use below.
3. Start the site: `python -m http.server 8000 --directory docs` → open **http://localhost:8000** and log in.

To run one of the extra tests: copy that line into a new query, **delete the `-- ` at the start**, and click **Run**. Then refresh the pick page.

## Tests

| # | Do this | You should see |
|---|---|---|
| 1 | Open **My pick** | **IN**, "Gameweek 2", the deadline as next Friday 5:00pm, and a countdown |
| 2 | Tap **Premier League** | Club tiles with colour stripes, no logos. **Arsenal is greyed out** ("Used GW1") and can't be tapped |
| 3 | Tap **Chelsea** | A bar at the bottom: "Pick Chelsea?" |
| 4 | Tap **Confirm** | Success message. Chelsea is shown as your pick. **My run** shows GW1 Arsenal (green) and GW2 Chelsea (pending) |
| 5 | **Change pick** → League Two → York City → Confirm | Your pick is now York City |
| 6 | Refresh the page | Still York City (it's saved) |
| 7 | Extra test **"Lock picks now"**, then refresh | Pick shows **Locked**. No Change pick button |
| 8 | Extra test **"Unlock again"** | Picker is back |
| 9 | Extra test **"Make it a Week off"** | "Week off – no pick needed". Then run **"Back to Normal"** |
| 10 | Extra test **"Make it a Custom week…"** (both lines) | Only Chelsea, Wrexham, York City and Barnet are offered. Then run both **"Back to Normal"** lines |
| 11 | Log in as your **test player** in a private window (Stage 1 sign-up) | Their own picker. Make a different pick |
| 12 | Phone check: on your PC, press **F12**, click the phone/tablet icon, choose an iPhone size | Everything fits with no sideways scrolling. Tiles are easy to tap |

**Already checked automatically on a test copy of the database:**
- **Teams:** you can't re-use a team from an earlier week, and you can't pick a non-league side in a normal week. In a Custom week only the listed teams can be picked.
- **Who can pick:** players who are out, or not in the game, can't pick. Week off blocks picks.
- **Deadlines:** picks are refused after the deadline. A reopened player can re-pick, and nobody else sees the re-pick until the new deadline.
- **Logged out:** visitors can't call any of this.

## When you're done

Leave the test game in place for Stage 3, or remove it with the last line of the test file (`delete from public.games where name = 'Test game';`).
