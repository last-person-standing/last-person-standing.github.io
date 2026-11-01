// Edge Function: invite-player
// Called from the host screen. Checks the caller is a host, then asks
// Supabase Auth to email an invite link. The secret (service role) key is
// only ever used here on the server - never in the website.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey());

    // Who is calling? Check their login token with Supabase Auth.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Please log in again." }, 401);

    const { data: caller } = await admin
      .from("profiles").select("role").eq("id", user.id).single();
    if (caller?.role !== "host") return json({ error: "Only hosts can invite players." }, 403);

    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim().slice(0, 60);
    const redirectTo = String(body.redirectTo ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "That email address doesn't look right." }, 400);
    }

    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { display_name: name },
      redirectTo: redirectTo || undefined,
    });
    if (error) {
      const msg = /already/i.test(error.message)
        ? "That email already has an account. They can use \"Forgot password\" on the login page."
        : error.message;
      return json({ error: msg }, 400);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: `Something went wrong: ${e instanceof Error ? e.message : e}` }, 500);
  }
});
