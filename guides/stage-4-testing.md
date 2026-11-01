# Stage 4: testing the overview page

Do Stages 1–3 first.

## Setup

1. Supabase → **SQL Editor** → **New query** → paste all of `supabase/006_overview.sql` → **Run**.
2. You need a game with a few gameweeks. Easiest: use the Stage 3 test steps (start a game, picks, fast-forward, results, next gameweek) and play through 2–3 weeks with your test players.

## Tests

| # | Do this | You should see |
|---|---|---|
| 1 | Open **Overview** as a test player while the current week's deadline is still in the future | Survivors, e.g. "2 of 3 still in". The current week's picks are **hidden**: "hidden until Fri …, 5:00pm". Past weeks are visible in the grid |
| 2 | In the grid, look at the current gameweek column | Hidden cells (lock or "?"). Nobody's pick for this week shows, not even in the chart |
| 3 | Fast-forward the deadline (SQL from the Stage 3 guide) and refresh | This week's picks appear in the grid and in the **bar chart** |
| 4 | Host marks results and confirms | Bars and cells turn green (won) or red (lost). Players who went out are listed below survivors, with "Out GWn" |
| 5 | Check your own row | It's highlighted |
| 6 | Search for a name, then filter **Out** | The grid narrows correctly |
| 7 | On a phone-sized screen (F12 → phone icon) scroll the grid sideways | Names stay pinned on the left. The page itself doesn't scroll sideways |
| 8 | End the game (Host → Game) and open Overview | The winner is shown at the top. The past-games selector lists the finished game |
| 9 | Postpone a club (Host → Postponed) after the deadline | Re-picks by those players stay hidden until their new deadline |

**Already checked automatically on a test copy of the database:**
- **Hidden picks:** nobody can see this week's picks before the deadline, and reopened re-picks stay hidden until their own deadline.
- **Emails:** the overview never includes email addresses.
- **Logged out:** visitors can't load it.
