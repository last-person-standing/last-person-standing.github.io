// Shared code for every page: Supabase connection, login check, header.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY, GAME_NAME } from "../config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export { GAME_NAME };

export const $ = (sel, root = document) => root.querySelector(sel);

// Full URL of another page in this site (works locally and on GitHub Pages)
export const pageUrl = (page) => new URL(page, location.href).href;

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Bank payment reference for a player, e.g. "LPS-12-JASON" (max 18 chars for UK banks)
export function payRef(prefix, profile) {
  const first = (profile.display_name.trim().split(/\s+/)[0] || "")
    .toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  return [prefix, profile.player_no, first].filter(Boolean).join("-");
}

// Show a message in a .msg element. type: "ok" | "error" | ""
export function say(el, text, type = "") {
  el.textContent = text;
  el.className = `msg ${type}`;
}

// Never-resolving promise, used while the browser is redirecting
const halt = () => new Promise(() => {});

// Make sure someone is logged in (and optionally a host). Returns their profile.
export async function requireUser({ host = false } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace("index.html");
    return halt();
  }
  const { data: profile, error } = await sb
    .from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !profile) {
    document.body.innerHTML =
      `<main class="page"><p class="msg error">Couldn't load your profile. Please refresh, or ask the host.</p></main>`;
    return halt();
  }
  if (host && profile.role !== "host") {
    location.replace("pick.html");
    return halt();
  }
  renderHeader(profile);
  return profile;
}

function renderHeader(profile) {
  const here = location.pathname.split("/").pop() || "index.html";
  const links = [
    ["pick.html", "My pick"],
    ["overview.html", "Overview"],
    ...(profile.role === "host" ? [["host.html", "Host"]] : []),
  ];
  const header = document.createElement("header");
  header.className = "topbar";
  header.innerHTML = `
    <div class="brand">${escapeHtml(GAME_NAME)}</div>
    <nav>
      ${links.map(([href, label]) =>
        `<a href="${href}"${href === here ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
      <button type="button" class="linkish" id="logout">Log out</button>
    </nav>`;
  document.body.prepend(header);
  $("#logout", header).addEventListener("click", async () => {
    await sb.auth.signOut();
    location.replace("index.html");
  });
}

// Show the app name wherever a page has data-game-name
document.querySelectorAll("[data-game-name]").forEach((el) => (el.textContent = GAME_NAME));
document.title = document.title.replace(/ · .*$/, ` · ${GAME_NAME}`);
