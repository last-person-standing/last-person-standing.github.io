# Stage 3: testing the host screen

Do Stages 1 and 2 first. You'll need yourself as host plus **two test players** (sign up two of your own email addresses, or ask a friend or two).

## Setup (2 minutes)

1. Supabase → **SQL Editor** → **New query** → paste all of `supabase/005_host.sql` → **Run**.
2. If the Stage 2 test game is still there, remove it (a new game can't start while one is running):
   ```sql
   delete from public.games where name = 'Test game';
   ```
3. Start the site (`python -m http.server 8000 --directory docs`), log in as host and open the **Host** tab.

To test results without waiting until Friday, you'll "fast-forward" the deadline with this line in the SQL Editor:
```sql
update public.gameweeks set deadline = now() - interval '1 minute' where status = 'open';
```

## Tests

### Players and credit
| # | Do this | You should see |
|---|---|---|
| 1 | **Players** tab | Everyone listed. Test players show **Awaiting payment** and a reference like `LPS-2-SAM` |
| 2 | Tap a test player → **+2** | Credit 2. The "Awaiting payment" badge goes |
| 3 | Same player → **Remove credit** 1, reason "test" | Credit 1. **Credit history** shows both changes |
| 4 | Give yourself +1 and the second test player +1 | Everyone has 1 credit |
| 5 | Log in as a test player (private window) | "Awaiting payment" box gone. Credit shows 1 game |

### Starting a game
| # | Do this | You should see |
|---|---|---|
| 6 | **Game** tab → Start new game, name "Test 1", leave the deadline as is | A warning saying how many players will be entered and charged, then "Game started" |
| 7 | **Players** tab | Everyone who had credit shows **In** and 0 credit |
| 8 | As each test player, make a pick on **My pick** | Picks saved |

### Week controls (before the deadline)
| # | Do this | You should see |
|---|---|---|
| 9 | **This week** | "2 of 3 picked" (or similar), and who hasn't picked |
| 10 | Week type → **Custom**, choose 4 clubs including one a test player picked, Save | "N picks removed" for anyone whose club isn't in the list. They now only see those 4 clubs |
| 11 | **Add non-league club** (e.g. "Chester FC", two colours), add it to the list, Save | It appears in the test player's picker |
| 12 | Week type back to **Normal**, Save | Non-league picks are removed. Players see all 92 clubs again |
| 13 | **Override a pick**: choose yourself → a club | Your pick is set |

### Results (after the deadline)
| # | Do this | You should see |
|---|---|---|
| 14 | Run the "fast-forward" SQL line, then tap **Refresh** | **Results** mode: each picked club with its count, Won / Lost / Postponed buttons |
| 15 | On a test player's club, tap **Postponed**, keep the new deadline, confirm | That player can pick again on **My pick** (with the "postponed" banner). Confirm results is blocked until they do |
| 16 | As that test player, re-pick | The new club appears in the host's results list |
| 17 | Mark one club **Won** and the others **Lost** | **Summary** preview, e.g. `1 in, 2 out this week: Leeds (1), …`. **Copy summary** works |
| 18 | **Confirm results** → confirm the dialog | Players on red clubs (and anyone with no pick) are **Out**. As an out player, My pick shows **OUT** and a red cell in My run |
| 19 | **Undo results** | Everyone back **In**. Then **Confirm results** again |
| 20 | **Open next gameweek** (Normal, default deadline) | Gameweek 2 open. Clubs used in GW1 are greyed out for the survivors |

### Ending and history
| # | Do this | You should see |
|---|---|---|
| 21 | **Game** tab → **End game**. The survivor is pre-ticked as winner. Add a note → confirm | The game appears under **History** with the winner |
| 22 | Give a player 1 credit and start "Test 2" | Only players with credit are entered |

### Clubs and settings
| # | Do this | You should see |
|---|---|---|
| 23 | **Clubs** tab | Counts per league: 20 / 24 / 24 / 24 (plus Non-league) |
| 24 | Edit a club: move it to another league, change a colour, Save | Shown in the new league on the player's picker |
| 25 | Set a club to **inactive** | It disappears from the player's picker |
| 26 | **Players** → open a test player → **Make host** → confirm. Log in as them | They now see the Host tab. Make them a player again afterwards |
| 27 | **Settings** | The payment details form is there and still saves |

## Clean up afterwards

Remove the test games before real use:
```sql
delete from public.games;            -- removes all games, weeks, entries and picks
update public.profiles set credit = 0;
delete from public.credit_log;
delete from public.teams where league = 'NL';   -- any test non-league clubs (only if unused)
```
Then undo any club edits from tests 24–25 on the Clubs tab.

**Already checked automatically on a test copy of the database:**
- **Host only:** players can't call any host function.
- **Credit:** it can't go below 0, and starting a game charges each entered player exactly 1 credit. Every change is logged.
- **Games:** a second game can't start while one is running.
- **Results:** they can't be confirmed while clubs are unmarked or a reopened player is still due to re-pick. Undo puts everyone back exactly.
- **Weeks:** they can't be changed after the deadline (use Reopen). Week off removes picks without using up anyone's team.
- **Hosts:** the last host can't be removed.
