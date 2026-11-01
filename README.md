# Last Person Standing

A football "last person standing" game for a private group. Each gameweek, players still in pick one team from the Premier League, Championship, League One or League Two. Win and you survive; draw or lose and you're out. Each team can be used once per game.

- **Website:** static HTML/CSS/JS in `docs/`, hosted on GitHub Pages.
- **Backend:** Supabase (login, Postgres with Row Level Security, Edge Functions) in `supabase/`.
- **Guides:** setup and testing steps in `guides/`.

The app never takes payments. The host tracks credit (games) after players pay them directly.
