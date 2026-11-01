# Deployment guide: putting Last Person Standing live

Everything is free. Allow about 1½ hours the first time. Do the steps in order; each links to the detailed guide.

**The live site:** https://jasonvincent10.github.io/last-person-standing/
**The code:** https://github.com/jasonvincent10/last-person-standing

## What lives where

| Piece | Where | Holds secrets? |
|---|---|---|
| Website (`docs/` folder) | GitHub Pages, free and public | No. Only the public Supabase key |
| Database, logins, security rules | Supabase (free) | Yes: the database password, plus the secret keys used only by the server |
| Email sending | Brevo (free, 300 emails a day) | Yes: the SMTP key and API key, stored only in Supabase |
| Keep-alive (stops Supabase pausing) | GitHub Actions (free) | No |

---

## Checklist

### A. Supabase and logins: [stage-1-setup.md](stage-1-setup.md), steps 1–6
- [ ] Supabase project created (region: London)
- [ ] SQL run, in this order: `001_schema` → `002_seed_teams` → `003_signup_payment` → `004_picks` → `005_host` → `006_overview` → `007_chase_emails`
- [ ] Brevo account, verified sender, SMTP key → Supabase SMTP settings
- [ ] Sign-ups on, "Confirm email" on, email rate limit set to 100 an hour
- [ ] `invite-player` function deployed, "Verify JWT" off
- [ ] `docs/config.js` has your Project URL and Publishable key

### B. Put the site live
1. **Push your `config.js` change to GitHub.** In VS Code: click the **Source Control** icon on the left (it looks like a branch). Type a message such as `Add Supabase settings`, click **Commit**, then **Sync Changes**.
   *Or ask me to commit and push it for you.*
2. **Wait 1–2 minutes**, then open https://jasonvincent10.github.io/last-person-standing/. You should see the login page.
   *To check progress: GitHub repo → **Actions** tab → "pages build and deployment" should show a green tick.*
3. **Tell Supabase about the live address.** Supabase → **Authentication → URL Configuration**:
   - **Site URL:** `https://jasonvincent10.github.io/last-person-standing/`
   - **Redirect URLs** → add `https://jasonvincent10.github.io/last-person-standing/**`
   - Keep the `http://localhost:8000/**` entry for testing on your PC.
- [ ] Live login page loads on your phone
- [ ] Supabase URL Configuration updated

### C. Make yourself host: [stage-1-setup.md](stage-1-setup.md), step 8
- [ ] Signed up on the **live** site, confirmed email, SQL run to make yourself host (and Rog)
- [ ] Host → Settings → **Payment details** saved

### D. Chase emails: [stage-5-setup.md](stage-5-setup.md)
- [ ] Brevo API key, with Authorised IPs blocking off
- [ ] Function secrets: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `CRON_SECRET`
- [ ] `chase-emails` function deployed, "Verify JWT" off
- [ ] `008_schedule_chase.sql` run with your two values, then the saved query deleted
- [ ] On the **live** site: Host → Settings → Chase emails → **Save** (so emails link to the live site) → **Send me a test email**

### E. Keep-alive (stops Supabase pausing over breaks)
Already set up in `.github/workflows/keep-alive.yml`. It switches itself on once `config.js` has your real details.
1. GitHub repo → **Actions** tab → **Keep Supabase awake** → **Run workflow** → **Run workflow**.
2. After about 30 seconds it should show a green tick. Click into it: the "Ping Supabase" step ends with "Supabase is awake."
- [ ] Keep-alive ran successfully by hand

After that it runs every 3 days on its own. If it ever fails, GitHub emails you. If Supabase does pause anyway, open the Supabase dashboard and click **Restore project**; your data is kept.

### F. Final checks (on your phone)
- [ ] Sign up a test player → confirmation email → **Awaiting payment** with bank details
- [ ] Host gives credit → start a game → the test player picks a club
- [ ] Overview hides this week's picks until 5pm Friday
- [ ] Clean up test data before the real game (SQL at the end of [stage-3-testing.md](stage-3-testing.md))

---

## Going live with the group
1. Make sure the real host(s) are set up and the payment details are correct.
2. Share **https://jasonvincent10.github.io/last-person-standing/** in the group chat with a line like:
   > *Sign up here, then pay £5 per game using the reference shown on your page. Check your spam folder for the confirmation email and mark it "Not spam".*
3. As payments arrive, the host adds credit. When ready, the host taps **Start new game**.

## Updating the site later
- I make changes and push them to GitHub. The live site updates by itself within a couple of minutes.
- Database changes come as a new numbered `.sql` file to run once in the SQL Editor.
- Each summer: Host → **Clubs** for promotion and relegation (the Premier League, Championship, League One and League Two need 20 / 24 / 24 / 24 clubs).

## Costs
£0, on these free limits:
- **Supabase:** 500 MB database and 50,000 users.
- **Brevo:** 300 emails a day.
- **GitHub Pages and Actions:** free for public repositories.

The only optional cost is your own domain (about £10 a year), if emails keep landing in spam.
