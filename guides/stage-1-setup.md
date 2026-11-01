# Stage 1 setup: database and login

Takes about 30–40 minutes. Everything here is free. If a button name on a website is slightly different from what's written here, look for the nearest match (these sites rename things now and then).

---

## 1. Create your Supabase project (the database and logins)

1. Go to **supabase.com** → **Start your project** → sign up (email, or "Continue with GitHub").
2. Click **New project**:
   - **Name:** `last-person-standing`
   - **Database password:** click **Generate**, then save it in your password manager. You'll rarely need it, but you can't see it again later.
   - **Region:** *West EU (London)* (closest to your players).
   - **Plan:** Free.
3. Wait 1–2 minutes while it sets up.

## 2. Create the tables

1. In the left menu, open **SQL Editor** → **New query**.
2. Open `supabase/001_schema.sql` from this project in VS Code, copy all of it, paste it into the editor and click **Run**.
   You should see *"Success. No rows returned"*.
3. **Only after you've confirmed the club list**, do the same with `supabase/002_seed_teams.sql`.
4. Then do the same with `supabase/003_signup_payment.sql` (sign-up and payment details).
5. Then, one at a time and in this order, the same with `004_picks.sql`, `005_host.sql`, `006_overview.sql` and `007_chase_emails.sql`. The website needs all of these to load. (Don't run anything in `supabase/test/` on your real project. `008` comes later, in the Stage 5 guide.)
6. Check: left menu → **Table Editor** → `teams` should show 92 rows.
7. Optional check that UK time is handled correctly. Run:
   ```sql
   select next_friday_deadline() at time zone 'Europe/London';
   ```
   It should show next Friday at 17:00.

## 3. Set up Brevo (sends the emails)

1. Go to **brevo.com** → **Sign up free**. Fill in the short questionnaire (choose a free/personal option where offered).
2. **Add a sender** (the "From" address players will see): open the menu under your name (top right) → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**. Use the email you want the game emails to come from, then click the confirmation link Brevo sends you.
3. **Get the SMTP details**: menu under your name → **SMTP & API** → **SMTP** tab → **Generate a new SMTP key**. Name it `supabase` and copy the key straight away. Also note the **Login** shown on that page (it looks like `abc123@smtp-brevo.com`).

## 4. Connect Supabase logins to Brevo

In Supabase:

1. **Authentication → Emails → SMTP Settings** → turn on **Enable custom SMTP**:
   - **Sender email:** the address you verified in Brevo
   - **Sender name:** `Last Person Standing`
   - **Host:** `smtp-relay.brevo.com`  **Port:** `587`
   - **Username:** the Brevo SMTP *Login*
   - **Password:** the SMTP key you generated
   - **Save**
2. **Authentication → Rate Limits** → set *emails sent per hour* to **100** (so you can invite everyone in one go). Save.
   Also **Authentication → Sign In / Providers → Email** → set **Email OTP Expiration** to `86400` (24 hours). Emails without your own domain can arrive late, and links otherwise expire after 1 hour.
3. **Authentication → Sign In / Providers**: make sure **"Allow new users to sign up"** is **on** and, under Email, **"Confirm email"** is **on**. Players sign themselves up from the link, and the confirmation email proves the address is real. If there's a **minimum password length** setting, set it to **8**.
   *Anyone with the link can create an account, but they can't play until the host adds credit.*
4. **Authentication → URL Configuration**:
   - **Site URL:** `http://localhost:8000`
   - **Redirect URLs** → **Add URL** → `http://localhost:8000/**`
   (We'll add the real GitHub Pages address at the deployment stage.)
5. Optional: **Authentication → Emails → Templates**. Change the subjects so players recognise them, and leave the `{{ .ConfirmationURL }}` part of each message as it is, because that's the link:
   - **Confirm signup:** `Confirm your Last Person Standing account`
   - **Invite user:** `You're invited to Last Person Standing`
   - **Reset password:** `Reset your Last Person Standing password`

## 5. Add the invite function

1. Left menu → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `invite-player`.
3. Delete the sample code, paste the whole of `supabase/functions/invite-player/index.ts` and click **Deploy**.
4. Open the function's **Details/Settings** and turn **off** the "Verify JWT" / "Enforce JWT verification" switch, then save. *Why:* the function checks the person's login and host role itself. The built-in check can reject valid logins on new projects.

You do **not** need to add any secret keys. Supabase gives the function its secret key automatically, and it never leaves Supabase.

## 6. Connect the website to your project

1. In Supabase, click **Connect** (top of the page), or open **Project Settings → API Keys**.
2. Copy the **Project URL** (`https://xxxx.supabase.co`) and the **Publishable key** (starts `sb_publishable_`). If you only see an "anon public" key, use that.
3. Open `docs/config.js` in VS Code and paste them in place of the placeholders. Save.

> The publishable key is meant to be public. The database security rules decide what it can do. Never paste the **secret** / **service_role** key anywhere in the `docs` folder.

## 7. Run the site on your PC

In VS Code: **Terminal → New Terminal**, then type:

```
python -m http.server 8000 --directory docs
```

Leave that running and open **http://localhost:8000** in your browser. (Press `Ctrl+C` in the terminal to stop it.)

## 8. Make yourself the first host

1. On **http://localhost:8000** tap **New? Sign up**, then enter your name, email and a password.
2. Open the confirmation email (check spam, and mark it "Not spam") and click the link. You'll be logged in.
3. Supabase → **SQL Editor** → run this with your email:
   ```sql
   update public.profiles set role = 'host' where email = 'you@example.com';
   ```
4. Refresh the site. You'll now see a **Host** tab.
5. **Host** tab → **Payment details** → fill in the bank account players should pay into → **Save**.

To make another host later, run the same SQL with their email.

---

## How to test Stage 1

Use a second email address of your own (or a friend's) as a test player.

| # | Do this | You should see |
|---|---|---|
| 1 | Log in as yourself | "Hello, *your name*" and the tabs **My pick · Overview · Host** |
| 2 | In a **private/incognito window**, sign up with your second email | "Nearly there! We've emailed…" |
| 3 | Try to log in with it **before** confirming | "Please confirm your email first…" |
| 4 | Click the confirmation link in that email | You land on **My pick**, with **Awaiting payment**, the bank details, a reference like `LPS-2-SAM` and Copy buttons. There's **no Host tab** |
| 5 | Change the address to `…/host.html` | You're sent straight back to My pick |
| 6 | In your host window, refresh **Host** | The new player is listed with **Awaiting payment** and the same reference |
| 7 | As the test player: log out → **Forgot password?** → enter the test email | "If that email has an account…", then a reset email arrives |
| 8 | Use the reset link, set a new password, log in with it | Works. The old password no longer works |
| 9 | Tap the **same** reset link again | "This link has expired or was already used…" |
| 10 | Optional: Host → **Invite a player** with a third email | Invite email arrives. The link goes to "Set your password" with the name filled in |

Phone testing needs the phone to reach your PC. The easiest way is to wait until Stage 6, when the site is on GitHub Pages.

**Already checked automatically on a test copy of the database:**
- **Profiles:** players only see their own email. They can't change their credit or role, or set a blank name.
- **Bank details:** players can read them but not change them, and logged-out visitors see nothing.
- **Picks:** players can't insert picks directly, and other players' picks stay hidden until the deadline passes. The same team can't be used twice in a game.
- **Teams:** players can't add teams.
- **Deadlines:** Friday 17:00 stays 17:00 UK time across the March and October clock changes.

## If something goes wrong

- **"Sign-ups are switched off":** turn "Allow new users to sign up" back on (step 4.3).
- **No confirmation or invite email:** check spam; in Brevo look at **Transactional → Logs**; check the SMTP settings in step 4.
- **"Invite failed" / error on the Host page:** check the function is named exactly `invite-player` and "Verify JWT" is off (step 5).
- **The invite link opens a "can't be reached" page:** start the local server (step 7), and check the Redirect URL in step 4.
- **"Link expired" on the first click:** some work email systems open links to scan them, which uses them up. Ask for a new one with "Forgot password".
