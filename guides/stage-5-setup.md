# Stage 5: chase emails (setup and testing)

Chase emails go **only** to players still in who haven't picked for the current gameweek, at the days and times the host chooses (default Wednesday, Thursday and Friday at 9am UK time). Nothing is sent in a Week off or after the deadline, and nobody gets the same reminder twice.

How it works: every hour Supabase's scheduler calls the `chase-emails` function. The function checks whether it's one of the host's send times, and if so emails the right people through Brevo.

Takes about 20 minutes. Do Stages 1–4 first.

---

## 1. Run the database update

Supabase → **SQL Editor** → **New query** → paste all of `supabase/007_chase_emails.sql` → **Run**.

## 2. Get a Brevo API key

This is a different key from the SMTP key in Stage 1.

1. Brevo → menu under your name → **SMTP & API** → **API Keys** tab → **Generate a new API key**. Name it `chase-emails` and copy it straight away.
2. Brevo → menu under your name → **Security** → **Authorised IPs**. If IP blocking is on, **turn it off** (deactivate). Supabase's servers don't have a fixed address, so Brevo would otherwise block the emails.
   *This is safe as long as the API key stays secret. It only ever goes into Supabase's secrets (step 4), never into the website.*

## 3. Make a "cron secret"

This is a long random password that only the scheduler knows, so nobody else can trigger emails. In Supabase **SQL Editor**, run:

```sql
select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
```

Copy the result (64 letters and numbers). You'll paste it in two places: steps 4 and 6.

## 4. Add the secrets to Supabase

Supabase → **Edge Functions** → **Secrets** (sometimes under *Manage secrets*) → add each of these:

| Name | Value |
|---|---|
| `BREVO_API_KEY` | the API key from step 2 |
| `BREVO_SENDER_EMAIL` | the sender address you verified in Brevo (Stage 1) |
| `BREVO_SENDER_NAME` | `Last Person Standing` |
| `CRON_SECRET` | the random value from step 3 |

> Secrets live only on Supabase's servers. They're never in the website or on GitHub.

## 5. Add the chase-emails function

1. **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `chase-emails`.
3. Paste the whole of `supabase/functions/chase-emails/index.ts` → **Deploy**.
4. In the function's settings, turn **off** "Verify JWT" (or "Enforce JWT verification"), as you did for `invite-player`. The function checks the cron secret, or the host's login, itself.

## 6. Turn on the hourly schedule

1. Open `supabase/008_schedule_chase.sql` in VS Code and copy it into a new SQL Editor query.
2. **In the editor**, replace the two values marked `<<<`. Keep the quote marks around each one:
   - `https://YOUR-PROJECT-REF.supabase.co` → your Project URL (same as in `docs/config.js`)
   - `PASTE-THE-SAME-CRON_SECRET-HERE` → the value from step 3
3. **Run**. You should see a number (the job id) at the end. If you see "Replace the two values marked <<< first", one wasn't replaced.
4. The SQL Editor keeps your query. Since it now contains the secret, delete that saved query (the **⋯** menu next to it → Delete).

*Don't save your real values back into the file in VS Code, because that file goes to GitHub. It's safe to run this again later, e.g. to change the secret.*

## 7. Check the host settings

Site → **Host** → **Settings** → **Chase emails**: check the send times, adjust the wording if you like, and tap **Save**. Saving also stores the pick-page link that goes in `{link}`.

- **Saving from your PC** (`localhost`): emails link to your PC. That's fine for testing.
- **After the site is live (Stage 6):** open Host → Settings on the live site and tap **Save** once more, so emails link to the real site.
- **No saved link:** chase emails don't send at all.

---

## Tests

| # | Do this | You should see |
|---|---|---|
| 1 | Host → Settings → **Send me a test email** | "Sent to *your email*". The email arrives (check spam) with `[TEST]` in the subject, your name, the gameweek and deadline, and a working link |
| 2 | Have a game open with one test player who **hasn't picked** and one who **has**. Tap **Send chase now** | "Email 1 player now?" → only the player without a pick receives it |
| 3 | Tap **Send chase now** again straight away | Nobody gets a second copy ("1 skipped: already emailed in the last hour"). Nobody is chased twice within an hour, by the schedule or by Send now |
| 4 | Add a send time for **the next hour** (e.g. it's 14:20 → Today, 3pm). Save. Wait until just after 3pm | The unpicked player gets the email. **Recent sends** shows it |
| 5 | SQL: `select status_code, content from net._http_response order by created desc limit 5;` | Recent rows with status 200, e.g. `{"skipped":"Not a send time."}` for the other hours |
| 6 | Turn the switch **off**, Save, and repeat test 4 with another hour | Nothing is sent |
| 7 | Make the week a **Week off** and tap Send chase now | "This is a week off." Nothing is sent |

Remove the extra send time from test 4 afterwards, and switch emails back on.

## If something goes wrong

- **"Email isn't set up yet":** a secret is missing or misspelt (step 4). After adding secrets, re-deploy the function.
- **"Brevo said 401" or "unrecognised IP":** check the API key, and that Authorised IPs blocking is off (step 2).
- **Test works but scheduled emails never arrive:** run the "See the function's replies" check at the bottom of `008_schedule_chase.sql`.
  - `"No API key found in request"`: the saved Project URL has something after `.supabase.co` (e.g. `/rest/v1`). Re-run `008_schedule_chase.sql`, which now strips it.
  - `{"error":"Not allowed."}`: the two cron secrets don't match. Re-run `008_schedule_chase.sql` with the same value as the `CRON_SECRET` function secret. Check there are no spaces at either end of the secret.
  - Status **401** with a message about a JWT or authorization: "Verify JWT" is still on for `chase-emails` (step 5). The host buttons still work in this case, because they send a login, but the scheduler doesn't.
  - `{"skipped":"The pick link isn't set…"}`: tap **Save** on Host → Settings.
- **Emails land in spam:** expected sometimes without your own domain. Ask players to mark it "Not spam".

## Changing the sender later (e.g. to Rog's email)

1. Brevo → **Senders** → add Rog's address. Rog clicks the confirmation link Brevo sends him.
2. Supabase → Edge Functions → Secrets → change `BREVO_SENDER_EMAIL` to Rog's address.
3. Supabase → Authentication → Emails → SMTP Settings → change **Sender email** to Rog's address (this covers sign-up and password emails).
