// Edge Function: chase-emails
// Emails players who are still in but haven't picked for the current gameweek.
//   mode "cron": called every hour by pg_cron (with the CRON_SECRET header).
//                Only sends if this UK day/hour is one of the host's chosen send times.
//   mode "now":  a host taps "Send chase now" (sends regardless of the schedule).
//   mode "test": a host taps "Send me a test" (one email, to that host only).
// Nothing is ever sent in a Week off, after the deadline, or twice for the same slot.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Supabase provides the secret key automatically: new-style first, legacy as fallback
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys.default) return keys.default;
  } catch { /* fall through */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

// @helpers-start
const UK = "Europe/London";

// UK day of week (1 = Monday ... 7 = Sunday), hour, and a key like "2026-11-04 09"
export function ukNow(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(d);
  const p: Record<string, string> = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  return { day, hour: Number(p.hour), key: `${p.year}-${p.month}-${p.day} ${p.hour}` };
}

// e.g. "Friday 6 November, 5:00pm"
export function ukDeadline(iso: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK, weekday: "long", day: "numeric", month: "long",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(iso));
  const p: Record<string, string> = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}${(p.dayPeriod ?? "").toLowerCase().replace(/\s/g, "")}`;
}

export function isSendTime(slots: unknown, now: { day: number; hour: number }) {
  return Array.isArray(slots) &&
    slots.some((s) => Number(s?.day) === now.day && Number(s?.hour) === now.hour);
}

// Replace {name} {deadline} {gameweek} {link}; anything else is left as typed
export function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(name|deadline|gameweek|link)\}/g, (_, k) => vars[k] ?? "");
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Plain text -> simple HTML: escaped, line breaks kept, the pick link made clickable
export function toHtml(text: string, link: string) {
  let html = esc(text).replace(/\n/g, "<br>");
  if (/^https?:\/\/[^\s"<>]+$/.test(link)) {
    const safe = esc(link);
    html = html.split(safe).join(`<a href="${safe}">${safe}</a>`);
  }
  return `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5">${html}</div>`;
}

// A usable pick link: the live https site, or localhost while testing
export function linkOk(link: string) {
  return /^https:\/\/[^\s"<>]+$/.test(link) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"<>]*$/.test(link);
}

// Compare secrets without leaking how much matched through timing
export function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// @helpers-end

// Brevo errors that mean "stop trying" (bad key, out of credits, blocked, rate limited)
class StopSending extends Error {}

async function sendEmail(to: { email: string; name: string }, subject: string, text: string, link: string) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": Deno.env.get("BREVO_API_KEY")!,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: Deno.env.get("BREVO_SENDER_EMAIL"),
        name: Deno.env.get("BREVO_SENDER_NAME") || "Last Person Standing",
      },
      to: [{ email: to.email, name: to.name }],
      subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200),
      textContent: text,
      htmlContent: toHtml(text, link),
    }),
  });
  if (!res.ok) {
    const msg = `Brevo said ${res.status}: ${(await res.text()).slice(0, 200)}`;
    throw [401, 402, 403, 429].includes(res.status) ? new StopSending(msg) : new Error(msg);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey());
    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode ?? "cron");

    // Who is calling?
    let host: { email: string; name: string } | null = null;
    if (mode === "cron") {
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || !sameSecret(req.headers.get("x-cron-secret") ?? "", secret)) {
        return json({ error: "Not allowed." }, 401);
      }
    } else if (mode === "now" || mode === "test") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = await admin.auth.getUser(token);
      if (!user) return json({ error: "Please log in again." }, 401);
      const { data: me } = await admin
        .from("profiles").select("role, email, display_name").eq("id", user.id).single();
      if (me?.role !== "host") return json({ error: "Only hosts can send emails." }, 403);
      host = { email: me.email, name: me.display_name };
    } else {
      return json({ error: "Unknown mode." }, 400);
    }

    if (!Deno.env.get("BREVO_API_KEY") || !Deno.env.get("BREVO_SENDER_EMAIL")) {
      return json({ error: "Email isn't set up yet: add BREVO_API_KEY and BREVO_SENDER_EMAIL in Edge Function secrets." }, 500);
    }

    const { data: settings, error: sErr } = await admin.from("email_settings").select("*").single();
    if (sErr || !settings) throw new Error("Couldn't read the email settings.");
    const now = ukNow(new Date());

    if (mode === "cron") {
      if (!settings.enabled) return json({ skipped: "Chase emails are switched off." });
      if (!isSendTime(settings.send_slots, now)) return json({ skipped: "Not a send time." });
    }

    const { data: t, error: tErr } = await admin.rpc("chase_targets");
    if (tErr) throw new Error(tErr.message);
    const link = settings.pick_url || "";

    // Test: one email to the host, using real gameweek details if there are any
    if (mode === "test") {
      const vars = {
        name: host!.name,
        gameweek: String(t.gameweek?.number ?? 1),
        deadline: t.gameweek ? ukDeadline(t.gameweek.deadline) : "Friday, 5:00pm",
        link,
      };
      const text = fill(settings.body, vars);
      await sendEmail(host!, `[TEST] ${fill(settings.subject, vars)}`, text, link);
      return json({ ok: true, sent: 1, to: host!.email });
    }

    if (!t.gameweek) return json({ skipped: t.reason });
    if (!linkOk(link)) {
      return json({ skipped: "The pick link isn't set. Open Host → Settings on the live site and tap Save." });
    }

    // Nobody gets a second chase within an hour, whether it came from the schedule or "Send chase now"
    const { data: recent, error: rErr } = await admin.from("email_log")
      .select("player_id").eq("gameweek_id", t.gameweek.id)
      .gte("sent_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if (rErr) throw new Error(rErr.message);
    const recentIds = new Set((recent ?? []).map((r) => r.player_id));
    const players = (t.players as { id: string; email: string; name: string }[])
      .filter((p) => !recentIds.has(p.id));

    // One slot per scheduled hour; "send now" gets its own slot per hour
    const slot = mode === "cron" ? now.key : `manual ${now.key}`;
    const vars = { gameweek: String(t.gameweek.number), deadline: ukDeadline(t.gameweek.deadline), link };
    const started = Date.now();
    let sent = 0;
    let stopped = "";
    const failed: string[] = [];

    async function chase(p: { id: string; email: string; name: string }) {
      if (stopped) return;
      // Claim this player's slot first; if it's already logged, they've had this email
      const { data: claimed, error: cErr } = await admin.from("email_log")
        .upsert({ gameweek_id: t.gameweek.id, player_id: p.id, slot },
                { onConflict: "gameweek_id,player_id,slot", ignoreDuplicates: true })
        .select("id");
      if (cErr) { failed.push(`${p.name}: couldn't log (${cErr.message})`); return; }
      if (!claimed?.length) return;

      const personal = { ...vars, name: p.name };
      try {
        await sendEmail(p, fill(settings.subject, personal), fill(settings.body, personal), link);
        sent++;
      } catch (e) {
        if (e instanceof StopSending) stopped = e.message;
        // Release the claim so a later send can retry this player
        const { error: dErr } = await admin.from("email_log").delete().eq("id", claimed[0].id);
        failed.push(`${p.name}: ${e instanceof Error ? e.message : e}${dErr ? " (and couldn't clear the log entry)" : ""}`);
      }
    }

    // Five at a time, stopping well inside the function's time limit
    for (let i = 0; i < players.length && !stopped; i += 5) {
      if (Date.now() - started > 110_000) {
        stopped = `Stopped early to stay within the time limit; ${players.length - i} not emailed yet. Tap "Send chase now" to finish.`;
        break;
      }
      await Promise.all(players.slice(i, i + 5).map(chase));
    }

    return json({
      ok: !stopped && failed.length === 0,
      sent,
      skipped_recent: recentIds.size ? t.players.length - players.length : 0,
      failed: failed.length,
      errors: failed.slice(0, 5),
      stopped: stopped || undefined,
    });
  } catch (e) {
    return json({ error: `Something went wrong: ${e instanceof Error ? e.message : e}` }, 500);
  }
});
