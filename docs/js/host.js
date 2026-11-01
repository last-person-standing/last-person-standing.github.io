// Host screen: This week, Players, Game, Clubs and Settings.
import { sb, requireUser, $, say, escapeHtml, pageUrl, payRef } from "./app.js";

const LEAGUES = [
  ["PL", "Premier League"], ["CH", "Championship"], ["L1", "League One"],
  ["L2", "League Two"], ["NL", "Non-league"],
];
const LEAGUE_NAME = Object.fromEntries(LEAGUES);
const NORMAL_LEAGUES = ["PL", "CH", "L1", "L2"];
const EXPECTED = { PL: 20, CH: 24, L1: 24, L2: 24 };   // clubs per league, to spot mistakes
const MODE_NAME = { normal: "Normal week", off: "Week off", custom: "Custom week" };
const TAB_KEY = "lps-host-tab";
const TABS = ["week", "players", "game", "clubs", "settings"];

const me = await requireUser({ host: true });

/* @time-start (pure helpers; tested on their own) */
const UK_TZ = "Europe/London";
const pad = (n) => String(n).padStart(2, "0");

const ukWallFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
// UK wall-clock parts for an instant (ms since 1970)
function ukWall(ms) {
  const p = Object.fromEntries(ukWallFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
// How far UK clocks are ahead of UTC at this instant, in ms (0 in winter, 1 hour in summer)
function ukOffset(ms) {
  const w = ukWall(ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}
// UTC ISO string -> "YYYY-MM-DDTHH:mm" on the UK wall clock (for datetime-local inputs)
function isoToUkLocal(iso) {
  const w = ukWall(Date.parse(iso));
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}
// "YYYY-MM-DDTHH:mm" read as UK time -> UTC ISO string. Right across BST changes.
// Returns null if it isn't a time (or doesn't exist: the hour skipped when clocks go forward).
function ukLocalToIso(local) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(local || "");
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = wall - ukOffset(wall);
  t = wall - ukOffset(t);   // second pass, in case the first guess was on the other side of a change
  const iso = new Date(t).toISOString();
  return isoToUkLocal(iso) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` ? iso : null;
}
// Next Friday 5pm UK after this moment, as a datetime-local value (matches the server's default)
function nextFridayLocal(nowMs) {
  const w = ukWall(nowMs);
  let ahead = (5 - new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay() + 7) % 7;
  let local = "";
  for (let i = 0; i < 2; i++, ahead += 7) {
    const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + ahead));
    local = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T17:00`;
    const iso = ukLocalToIso(local);
    if (iso && Date.parse(iso) > nowMs) break;
  }
  return local;
}

const ukFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TZ, weekday: "short", day: "numeric", month: "short",
  hour: "numeric", minute: "2-digit", hour12: true,
});
// "Fri 7 Nov, 5:00pm" in UK time, whatever the phone's timezone
function fmtDeadline(iso) {
  const p = Object.fromEntries(ukFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}${p.dayPeriod.toLowerCase()}`;
}
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, day: "numeric", month: "short", year: "numeric" });
const fmtDate = (iso) => dateFormat.format(new Date(iso));
const shortFormat = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, day: "numeric", month: "short" });
const fmtShort = (iso) => shortFormat.format(new Date(iso));

// Days/hours/minutes, with seconds in the last hour
function fmtLeft(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// "86 in, 22 out this week: Blackburn (9), QPR (8), No pick (5)"
function summaryText(inCount, outCount, losing, noPick) {
  const parts = losing.slice()
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} (${n})`);
  if (noPick) parts.push(`No pick (${noPick})`);
  return `${inCount} in, ${outCount} out this week${parts.length ? `: ${parts.join(", ")}` : ""}`;
}
/* @time-end */

/* ---------- State ---------- */

const D = { offset: 0, settings: {} };   // everything fetched from the database
const ui = {
  tab: "week",
  week: { gwId: null, stale: false, mode: "normal", deadline: "", origDeadline: "", custom: new Set(), q: "", lg: "ALL", nlOpen: false },
  ov: { q: "", player: null, league: null, selected: null, used: new Map() },
  next: { mode: "normal", deadline: "", def: "" },
  start: { name: "", deadline: "", def: "" },
  end: { gameId: null, ticks: new Set(), note: "", touched: false },
  startResult: null,
  chase: { init: false, stale: false, enabled: true, slots: [], subject: "", body: "", target: "body", result: null, setup: "" },
  pq: "", pf: "all", cq: "",
  sheet: null,     // { kind: "player" | "club", id }
  opener: null,    // selector of the control that opened the detail panel
};
let busy = false;
let renderedPhase = null, lastDeadlineTry = 0, lastLoad = 0;

const nowMs = () => Date.now() + D.offset;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const prof = (id) => D.pById.get(id);
const pname = (id) => escapeHtml(prof(id)?.display_name || "Unknown player");
const teamName = (t) => t.short_name || t.name;
const byName = (a, b) => a.localeCompare(b, "en-GB", { sensitivity: "base" });

// Colours come from the database, so only let plain hex values into a style attribute
const hex = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : fallback);
function swatch(t) {
  return `<span class="swatch" style="--c1:${hex(t.colour1, "#888888")};--c2:${hex(t.colour2, hex(t.colour1, "#888888"))}" aria-hidden="true"></span>`;
}
const chip = (act, key, val, label, on) =>
  `<button type="button" class="chip" data-act="${act}" data-${key}="${escapeHtml(val)}" aria-pressed="${on}">${label}</button>`;

// Spoken name starts with the visible text: "Wolves, Wolverhampton Wanderers, used GW3"
function tileLabel(t, note) {
  const n = note.replace(/^✓\s*/, "");
  return [teamName(t), t.short_name && t.short_name !== t.name ? t.name : "", n ? n[0].toLowerCase() + n.slice(1) : ""]
    .filter(Boolean).join(", ");
}
function tile(t, { act, selected = false, note = "", disabled = false }) {
  return `
    <button type="button" class="team${selected ? " selected" : ""}" data-act="${act}" data-id="${t.id}"
      aria-pressed="${selected}" aria-label="${escapeHtml(tileLabel(t, note))}"${disabled ? " disabled" : ""}>
      ${swatch(t)}
      <span class="team-text">
        <span class="team-name">${escapeHtml(teamName(t))}</span>
        ${note ? `<span class="team-note">${escapeHtml(note)}</span>` : ""}
      </span>
    </button>`;
}

/* ---------- Messages, dialogs, calls ---------- */

let toastTimer;
function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").classList.remove("show");
  say($("#toast-ok"), ""); say($("#toast-err"), "");
}
// Errors go in the role="alert" line, everything else in the polite role="status" one.
// Inside the detail panel the message shows there (the toast would sit behind it).
function flash(text, type = "ok") {
  const inSheet = $("#sheet").open;
  const [ok, err] = inSheet ? [$("#sheet-msg"), $("#sheet-err")] : [$("#toast-ok"), $("#toast-err")];
  const [on, off] = type === "error" ? [err, ok] : [ok, err];
  say(off, "");
  say(on, text, type);
  if (inSheet) return;
  clearTimeout(toastTimer);
  $("#toast").classList.toggle("show", !!text);
  if (text) toastTimer = setTimeout(hideToast, type === "error" ? 12000 : 6000);
}
$("#toast").addEventListener("click", hideToast);

/* ---------- Keeping focus where it was ---------- */

// A CSS selector that finds "the same control" again after a re-render
function focusKey(el) {
  if (!el || el === document.body || !el.dataset) return null;
  const q = (v) => String(v).replace(/"/g, '\\"');
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.dataset.act) {
    return `[data-act="${q(el.dataset.act)}"]` + ["id", "result", "lg", "f", "n", "role", "i"]
      .filter((k) => el.dataset[k] != null).map((k) => `[data-${k}="${q(el.dataset[k])}"]`).join("");
  }
  if (el.type === "radio" && el.name) return `input[name="${q(el.name)}"][value="${q(el.value)}"]`;
  if (el.type === "submit" && el.form && el.form.dataset.form) return `form[data-form="${q(el.form.dataset.form)}"] [type=submit]`;
  return null;
}
let lastKey = null;       // the control last clicked (not counting the confirm dialog's own buttons)
let pendingKey = null;    // while an action runs: where focus should land afterwards
let focusDepth = 0;
document.addEventListener("click", (e) => {
  if (e.target.closest("#dlg")) return;
  lastKey = focusKey(e.target.closest("button, input, summary"));
}, true);

const focusLost = () => {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
};
// Run a re-render; if it destroyed the focused control, focus its equivalent in the new markup
function withFocus(render, prefer) {
  if (focusDepth) return render();
  const key = pendingKey || focusKey(document.activeElement);
  focusDepth++;
  try { render(); } finally { focusDepth--; }
  if (!focusLost()) return;
  const tries = [prefer, key, !$("#sheet").open && ui.opener].filter(Boolean);
  for (const sel of tries) {
    const el = document.querySelector(sel);
    if (el && !el.disabled && !el.closest("[hidden]")) { el.focus(); return; }
  }
}
// Last resort once an action has finished: the message that was just shown, else the current tab
function rescueFocus() {
  if (!focusLost()) return;
  const msg = $("#sheet").open ? (($("#sheet-err").textContent && $("#sheet-err")) || $("#sheet-msg"))
    : $("#toast").classList.contains("show") ? $("#toast") : null;
  if (msg) msg.focus();
  if (focusLost() || document.activeElement !== msg) { const t = $(".tabs [aria-selected=true]"); if (t && !$("#sheet").open) t.focus(); }
}

// Confirmation / input dialog. Resolves to the dialog body (still holding the inputs) or null if cancelled.
function ask({ title, body = "", ok = "Confirm", danger = false, validate }) {
  const dlg = $("#dlg"), root = $("#dlg-body"), okBtn = $("#dlg-ok"), noBtn = $("#dlg-cancel");
  $("#dlg-title").textContent = title;
  root.innerHTML = body;
  say($("#dlg-msg"), "");
  okBtn.textContent = ok;
  okBtn.className = danger ? "danger" : "go";
  okBtn.disabled = false;
  return new Promise((resolve) => {
    const done = (yes) => {
      okBtn.removeEventListener("click", onOk);
      noBtn.removeEventListener("click", onNo);
      dlg.removeEventListener("cancel", onNo);
      dlg.close();
      resolve(yes ? root : null);
    };
    const onOk = () => {
      const err = validate && validate(root);
      if (err) return say($("#dlg-msg"), err, "error");
      done(true);
    };
    const onNo = (e) => { if (e) e.preventDefault(); done(false); };
    okBtn.addEventListener("click", onOk);
    noBtn.addEventListener("click", onNo);
    dlg.addEventListener("cancel", onNo);
    dlg.showModal();
    // Typing dialogs focus the first field; plain confirmations focus Cancel, the safe choice
    (root.querySelector("input:not([type=checkbox]):not([type=hidden]), select") || noBtn).focus();
  });
}

async function rpc(name, args) {
  let r;
  try { r = await sb.rpc(name, args); }
  catch { throw new Error("Couldn't reach the server, so it may or may not have worked. Tap Refresh and check before trying again."); }
  if (r.error) throw new Error(r.error.message || "Something went wrong. Please try again.");
  return r.data;
}
async function write(query) {
  let r;
  try { r = await query; }
  catch { throw new Error("Couldn't reach the server. Please check your connection and try again."); }
  if (r.error) {
    throw new Error(r.error.code === "23505" ? "There's already a club with that name." : r.error.message || "Couldn't save.");
  }
  if (!r.data || !r.data.length) throw new Error("Couldn't save. You may not have permission.");
  return r.data;
}

// Run one action at a time: disable the button, re-fetch on success, show the result (or the error).
// Once the server call has succeeded the action is DONE: a failed re-fetch afterwards only adds a
// "couldn't refresh" note, and is never reported as the action failing (so nobody retries it).
async function act(btn, fn, okText, { light = false } = {}) {
  if (busy) return false;
  busy = true;
  if (btn) btn.disabled = true;
  pendingKey = (btn && focusKey(btn)) || lastKey;
  try {
    let data;
    try {
      data = await fn();
    } catch (e) {
      flash(e.message || "Something went wrong. Please try again.", "error");
      return false;
    }
    let stale = false;
    try { await (light ? refreshWeek() : refresh()); } catch { stale = true; }
    let text = null;
    try { text = typeof okText === "function" ? okText(data) : okText; } catch { text = "Done."; }
    if (stale) flash(`${text || "Done"}${/[.!]$/.test(text || "") ? "" : "."} But the page couldn't refresh. Tap Refresh.`, "ok");
    else if (text) flash(text, "ok");
    return true;
  } finally {
    busy = false;
    if (btn && btn.isConnected) btn.disabled = false;
    rescueFocus();
    pendingKey = null;
  }
}

/* ---------- Loading ---------- */

const must = (r) => { if (r.error) throw r.error; return r.data; };

async function load() {
  const [st, settings, profiles, teams, games, wins, mail] = await Promise.all([
    sb.rpc("my_game_state"),   // only used for the server clock
    sb.from("app_settings").select("*").single(),
    sb.from("profiles").select("id,display_name,email,role,credit,player_no").order("display_name"),
    sb.from("teams").select("id,name,short_name,league,colour1,colour2,active").order("name"),
    sb.from("games").select("id,name,status,started_at,ended_at,winner_note").order("started_at", { ascending: false }),
    sb.from("game_entries").select("game_id,player_id").eq("status", "winner"),
    sb.from("email_settings").select("*").eq("id", 1).single(),
  ]);
  if (st.data && st.data.now) D.offset = Date.parse(st.data.now) - Date.now();
  D.settings = settings.data || {};
  D.email = mail.error ? null : mail.data;
  D.warn = settings.error ? "Couldn't load the payment details, so bank references may be wrong. Tap Refresh to try again." : "";
  D.profiles = must(profiles);
  D.teams = must(teams);
  D.games = must(games);
  D.winners = new Map();
  for (const w of must(wins)) (D.winners.get(w.game_id) || D.winners.set(w.game_id, []).get(w.game_id)).push(w.player_id);

  D.active = D.games.find((g) => g.status === "active") || null;
  D.gws = []; D.entries = []; D.picks = []; D.allowed = new Set(); D.cur = null; D.emailLog = { slots: [], recent_players: 0 };
  if (D.active) {
    D.gws = must(await sb.from("gameweeks").select("id,game_id,number,mode,deadline,status")
      .eq("game_id", D.active.id).order("number"));
    D.cur = D.gws.find((g) => g.status === "open") || D.gws[D.gws.length - 1] || null;
    const [en, pk, gt] = await Promise.all([
      sb.from("game_entries").select("player_id,status,out_gameweek_id").eq("game_id", D.active.id),
      D.cur ? sb.from("picks").select("player_id,team_id,result,reopen_deadline").eq("gameweek_id", D.cur.id) : { data: [] },
      D.cur ? sb.from("gameweek_teams").select("team_id").eq("gameweek_id", D.cur.id) : { data: [] },
    ]);
    D.entries = must(en);
    D.picks = must(pk);
    D.allowed = new Set(must(gt).map((r) => r.team_id));
    if (D.cur) {
      const log = await sb.rpc("email_log_summary");
      D.emailLog = log.error || !log.data ? null : log.data;   // { slots, recent_players }; null = couldn't load
    }
  }
  index();
  lastLoad = Date.now();
}

// Lookup tables built from the fetched rows
function index() {
  D.pById = new Map(D.profiles.map((p) => [p.id, p]));
  D.tById = new Map(D.teams.map((t) => [t.id, t]));
  D.eById = new Map(D.entries.map((e) => [e.player_id, e]));
  D.pkBy = new Map(D.picks.map((p) => [p.player_id, p]));
}

// Just this week's entries and picks: quick refresh after marking a team
async function refreshWeek() {
  const [en, pk] = await Promise.all([
    sb.from("game_entries").select("player_id,status,out_gameweek_id").eq("game_id", D.active.id),
    sb.from("picks").select("player_id,team_id,result,reopen_deadline").eq("gameweek_id", D.cur.id),
  ]);
  D.entries = must(en);
  D.picks = must(pk);
  index();
  renderWeek();
  renderPlayers();
}

// One fetch at a time. A call made mid-fetch queues exactly one more, and waits for that one.
let running = null, again = null;
function refresh() {
  if (!running) {
    running = doRefresh().finally(() => { running = null; });
    return running;
  }
  again ??= running.then(() => { again = null; return refresh(); });
  return again;
}
async function doRefresh() {
  await load();
  renderAll();
}

/* ---------- Derived numbers ---------- */

const aliveEntries = () => D.entries.filter((e) => e.status === "alive");

function phase() {
  if (!D.active || !D.cur) return "none";
  if (D.cur.status === "resulted") return "done";
  return nowMs() < Date.parse(D.cur.deadline) ? "before" : "results";
}

// Open gameweek after the deadline: who picked which team, who didn't
function weekStats() {
  const byTeam = new Map(), noPick = [], waiting = [];
  let aliveN = 0;
  for (const e of aliveEntries()) {
    aliveN++;
    const pk = D.pkBy.get(e.player_id);
    if (pk && pk.team_id != null) {
      (byTeam.get(pk.team_id) || byTeam.set(pk.team_id, []).get(pk.team_id)).push({ id: e.player_id, result: pk.result });
    } else if (pk && pk.reopen_deadline && Date.parse(pk.reopen_deadline) > nowMs()) {
      waiting.push({ id: e.player_id, until: pk.reopen_deadline });
    } else noPick.push(e.player_id);
  }
  const teams = [...byTeam].map(([id, list]) => {
    const t = D.tById.get(id);
    const results = new Set(list.map((x) => x.result));
    return { id, team: t, name: t ? teamName(t) : "?", players: list.map((x) => x.id),
      result: results.size === 1 ? [...results][0] : "pending" };   // mixed (e.g. a later override) counts as not done
  }).sort((a, b) => b.players.length - a.players.length || a.name.localeCompare(b.name));
  const lost = teams.filter((x) => x.result === "lost");
  const pending = teams.filter((x) => x.result === "pending");
  const off = D.cur.mode === "off";
  const out = off ? 0 : lost.reduce((n, x) => n + x.players.length, 0) + noPick.length + waiting.length;
  return { teams, lost, pending, noPick, waiting, off, out, alive: aliveN, stay: aliveN - out,
    ready: off || (!pending.length && !waiting.length) };
}

// After results are confirmed: who went out this week and why
function doneStats() {
  const out = D.entries.filter((e) => e.out_gameweek_id === D.cur.id);
  const lost = new Map();
  let noPick = 0;
  for (const e of out) {
    const pk = D.pkBy.get(e.player_id);
    if (pk && pk.team_id != null) lost.set(pk.team_id, (lost.get(pk.team_id) || 0) + 1);
    else noPick++;
  }
  return {
    out: out.length, noPick, alive: aliveEntries().length,
    losing: [...lost].map(([id, n]) => [D.tById.get(id) ? teamName(D.tById.get(id)) : "?", n]),
  };
}

function playerStatus(p) {
  const e = D.eById.get(p.id);
  if (e) return e.status;                    // alive | out | winner
  return p.credit >= 1 ? "ready" : "wait";   // ready = has credit but not entered
}
function statusBadge(s) {
  return { alive: '<span class="badge won">In</span>', out: '<span class="badge lost">Out</span>',
    winner: '<span class="badge win">Winner</span>', wait: '<span class="badge wait">Awaiting payment</span>',
    ready: '<span class="badge">Not in game</span>' }[s];
}

/* ---------- Tabs ---------- */

function setTab(name, focus) {
  if (!TABS.includes(name)) name = "week";
  ui.tab = name;
  for (const t of TABS) {
    const on = t === name;
    $(`#tab-${t}`).hidden = !on;
    const b = $(`#tb-${t}`);
    b.setAttribute("aria-selected", on);
    b.tabIndex = on ? 0 : -1;
    if (on) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (on && focus) b.focus();
  }
  try { localStorage.setItem(TAB_KEY, name); } catch {}
}
$(".tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(ui.tab);
  const to = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  setTab(TABS[to], true);
});

/* ---------- Rendering ---------- */

function renderAll() {
  say($("#warn"), D.warn, D.warn ? "error" : "");
  syncForms();
  syncChase();
  renderWeek();
  renderPlayers();
  renderGame();
  renderClubs();
  renderChase();
  renderSheet();
}

// Keep unsaved form edits across refreshes, but start fresh for a new gameweek or after saving
function syncForms() {
  const w = ui.week, gw = D.cur;
  if (gw && gw.status === "open" && (w.gwId !== gw.id || w.stale)) {
    Object.assign(w, { gwId: gw.id, stale: false, mode: gw.mode, deadline: isoToUkLocal(gw.deadline),
      origDeadline: isoToUkLocal(gw.deadline), custom: new Set(D.allowed), q: "", lg: "ALL" });
  }
  const now = nowMs();
  for (const f of [ui.next, ui.start]) {
    const untouched = f.deadline === f.def;
    f.def = nextFridayLocal(now);
    if (!f.deadline || untouched) f.deadline = f.def;
  }
  if (D.active && (ui.end.gameId !== D.active.id || !ui.end.touched)) {
    const chosen = ui.end.gameId === D.active.id;
    ui.end.gameId = D.active.id;
    ui.end.ticks = new Set(endDefaults());
    ui.end.touched = false;
    if (!chosen) ui.end.note = "";
  }
}

/* ----- This week ----- */

const segHtml = (name, mode) => `
  <fieldset class="seg"><legend class="sr">Week type</legend>
    ${["normal", "off", "custom"].map((m) => `
      <label><input type="radio" name="${name}" value="${m}"${mode === m ? " checked" : ""}><span>${m === "off" ? "Week off" : m[0].toUpperCase() + m.slice(1)}</span></label>`).join("")}
  </fieldset>`;

function renderWeek() {
  const el = $("#tab-week");
  const ph = phase();
  renderedPhase = ph;
  if (ph === "none") {
    el.innerHTML = `
      <section class="card">
        <h2>No game running</h2>
        <p class="muted">Start a game on the Game tab. This tab then shows the current gameweek.</p>
        <button type="button" class="go full" data-goto="game">Go to the Game tab</button>
      </section>`;
    return;
  }
  const gw = D.cur;
  const status = ph === "before" ? `<span class="badge won">${gw.mode === "off" ? "Week off" : "Open for picks"}</span>`
    : ph === "results" ? '<span class="badge locked">Locked</span>' : '<span class="badge">Results confirmed</span>';
  const when = ph === "before" ? `Picks lock <strong>${escapeHtml(fmtDeadline(gw.deadline))}</strong> (UK time)`
    : `Picks locked ${escapeHtml(fmtDeadline(gw.deadline))} (UK time)`;
  const head = `
    <section class="card">
      <div class="row between">
        <h2>Gameweek ${gw.number}</h2>
        <button type="button" class="secondary" data-act="refresh">Refresh</button>
      </div>
      <p class="muted small">${escapeHtml(D.active.name)}</p>
      <div class="row">${status}<span class="badge">${MODE_NAME[gw.mode]}</span></div>
      <p class="when">${when}</p>
      <p class="muted" id="wk-left"></p>
    </section>`;

  let body = "";
  if (ph === "before") body = beforeHtml();
  else if (ph === "results") body = resultsHtml();
  else body = doneHtml();
  el.innerHTML = head + body;
  renderWkTeams();
  renderOverride();
  tick();
}

/* before the deadline */

function beforeHtml() {
  const gw = D.cur, w = ui.week;
  const aliveIds = aliveEntries().map((e) => e.player_id);
  const missing = aliveIds.filter((id) => !(D.pkBy.get(id) && D.pkBy.get(id).team_id != null))
    .sort((a, b) => byName(prof(a)?.display_name || "", prof(b)?.display_name || ""));
  const picked = aliveIds.length - missing.length;
  const pct = aliveIds.length ? Math.round((picked / aliveIds.length) * 100) : 0;
  const progress = gw.mode === "off"
    ? `<section class="card"><h2>Picks</h2><p class="week-off">Week off: nobody needs to pick.</p></section>`
    : `<section class="card">
        <h2>Picks so far</h2>
        <p><strong>${picked} of ${aliveIds.length}</strong> alive players have picked</p>
        <div class="meter" role="img" aria-label="${pct}% have picked"><span style="width:${pct}%"></span></div>
        ${missing.length
          ? `<h3>Yet to pick (${missing.length})</h3><ul class="names">${missing.map((id) => `<li>${pname(id)}</li>`).join("")}</ul>`
          : `<p class="muted">Everyone has picked.</p>`}
      </section>`;

  const custom = w.mode !== "custom" ? "" : `
    <h3>Allowed clubs <span class="muted small" id="wk-count"></span></h3>
    <label>Search clubs
      <input type="search" id="wk-q" autocomplete="off" maxlength="60" value="${escapeHtml(w.q)}">
    </label>
    <div class="chips" role="group" aria-label="Filter by league">
      ${chip("wk-lg", "lg", "ALL", "All", w.lg === "ALL")}
      ${LEAGUES.map(([c, n]) => chip("wk-lg", "lg", c, c === "NL" ? "Non-league" : n, w.lg === c)).join("")}
    </div>
    <div class="row">
      <button type="button" class="secondary" data-act="wk-all">Select all shown</button>
      <button type="button" class="secondary" data-act="wk-none">Clear shown</button>
    </div>
    <div class="scrollbox" tabindex="0" role="group" aria-label="Clubs"><div id="wk-teams" class="teams"></div></div>
    <details class="nl" id="wk-nl"${w.nlOpen ? " open" : ""}>
      <summary>Add non-league club</summary>
      <form data-form="add-nl" novalidate>
        <label>Name<input type="text" name="name" maxlength="60" autocomplete="off"></label>
        <label>Short name (max 12 characters)<input type="text" name="short" maxlength="12" autocomplete="off"></label>
        <div class="cols">
          <label>Colour 1<input type="color" name="c1" value="#1e7a4c"></label>
          <label>Colour 2<input type="color" name="c2" value="#ffffff"></label>
        </div>
        <button type="submit" class="secondary full">Add club to Non-league</button>
      </form>
    </details>`;

  const type = `
    <section class="card" id="wk-type">
      <h2>Week type</h2>
      ${segHtml("wk-mode", w.mode)}
      <label>Deadline (UK time)
        <input type="datetime-local" id="wk-deadline" value="${escapeHtml(w.deadline)}">
      </label>
      ${custom}
      <button type="button" class="go full" data-act="wk-save">Save changes</button>
    </section>`;
  return progress + type + overrideShell();
}

function shownTeams() {
  const w = ui.week, q = w.q.trim().toLowerCase();
  return D.teams
    .filter((t) => (t.active || w.custom.has(t.id)) && (w.lg === "ALL" || t.league === w.lg)
      && (!q || t.name.toLowerCase().includes(q) || (t.short_name || "").toLowerCase().includes(q)))
    .sort((a, b) => byName(a.name, b.name));
}
function renderWkTeams() {
  const el = $("#wk-teams");
  if (!el) return;
  const list = shownTeams();
  el.innerHTML = list.length
    ? list.map((t) => tile(t, { act: "wk-toggle", selected: ui.week.custom.has(t.id),
        note: ui.week.custom.has(t.id) ? "✓ Allowed" : (t.active ? "" : "Inactive") })).join("")
    : `<p class="muted">No clubs match.</p>`;
  $("#wk-count").textContent = `(${ui.week.custom.size} selected)`;
}

/* after the deadline */

function resultsHtml() {
  const s = weekStats();
  if (s.off) {
    return `
      <section class="card">
        <h2>Results</h2>
        <p class="week-off">Week off: nobody goes out. Confirm to move on.</p>
        ${confirmButton(s)}
      </section>`;
  }
  const rows = s.teams.map((x) => `
    <li class="res ${x.result}">
      <div class="res-top">
        ${x.team ? swatch(x.team) : ""}
        <span class="res-name">${escapeHtml(x.name)}</span>
        <span class="res-count">${plural(x.players.length, "player")}</span>
      </div>
      <div class="res-btns">
        <button type="button" class="res-btn won" data-act="res-set" data-id="${x.id}" data-result="won"
          aria-pressed="${x.result === "won"}" aria-label="Won: ${escapeHtml(x.name)}">Won</button>
        <button type="button" class="res-btn lost" data-act="res-set" data-id="${x.id}" data-result="lost"
          aria-pressed="${x.result === "lost"}" aria-label="Lost: ${escapeHtml(x.name)}">Lost</button>
        <button type="button" class="secondary res-post" data-act="res-post" data-id="${x.id}"
          aria-label="Postponed: ${escapeHtml(x.name)}">Postponed</button>
      </div>
    </li>`).join("");

  const names = (ids) => `<ul class="names">${ids.map((id) => `<li>${pname(id)}</li>`).join("")}</ul>`;
  const waiting = s.waiting.length ? `
    <h3>Waiting to pick again (${s.waiting.length})</h3>
    <p class="muted small">Their match was postponed. They go out if they don't pick before their new deadline.</p>
    <ul class="names">${s.waiting.map((x) => `<li>${pname(x.id)} <span class="muted small">until ${escapeHtml(fmtDeadline(x.until))}</span></li>`).join("")}</ul>` : "";

  return `
    <section class="card">
      <h2>Results</h2>
      <p class="muted small">Mark each team Won or Lost once its match is over. Tap again to clear.</p>
      ${s.teams.length ? `<ul class="reslist">${rows}</ul>` : `<p class="muted">Nobody picked a team this week.</p>`}
      <h3>No pick: will go out (${s.noPick.length})</h3>
      ${s.noPick.length ? names(s.noPick) : `<p class="muted">Everyone still in made a pick.</p>`}
      ${waiting}
      <button type="button" class="secondary full" data-act="res-reopen">Reopen picks for individual players</button>
    </section>
    ${s.ready ? summaryCard(s, true) : ""}
    <section class="card">
      <h2>Confirm results</h2>
      ${confirmButton(s)}
    </section>
    ${overrideShell()}`;
}

function confirmButton(s) {
  const why = s.ready ? "" : s.pending.length
    ? `Mark ${plural(s.pending.length, "more team")} Won or Lost first.`
    : "Some players are still waiting to pick again.";
  return `
    <button type="button" class="go big full" data-act="res-confirm"${s.ready ? "" : " disabled"}>Confirm results</button>
    ${why ? `<p class="muted small">${why}</p>` : ""}`;
}

function summaryCard(s, preview) {
  const text = s.off ? summaryText(s.alive, 0, [], 0)
    : summaryText(s.stay, s.out, s.lost.map((x) => [x.name, x.players.length]), s.noPick.length + s.waiting.length);
  return summaryHtml(text, preview);
}
function summaryHtml(text, preview) {
  return `
    <section class="card">
      <h2>Summary${preview ? ' <span class="muted small">(preview)</span>' : ""}</h2>
      <p class="summary" id="summary" tabindex="0">${escapeHtml(text)}</p>
      <button type="button" class="secondary full" data-act="copy" data-text="${escapeHtml(text)}">Copy summary</button>
    </section>`;
}

/* after results are confirmed */

function doneHtml() {
  const s = doneStats();
  const summary = summaryHtml(summaryText(s.alive, s.out, s.losing, s.noPick), false);
  const few = s.alive <= 1 ? `
    <section class="callout">
      <strong>${s.alive === 0 ? "Nobody is left in." : "Only one player is left in."}</strong>
      The game can be ended on the Game tab.
      <p><button type="button" class="go" data-goto="game">Go to the Game tab</button></p>
    </section>` : "";
  const nextForm = s.alive === 0 ? "" : `
    <form class="card" data-form="next-gw" novalidate>
      <h2>Open next gameweek</h2>
      ${segHtml("nx-mode", ui.next.mode)}
      <p class="muted small" id="nx-hint">${ui.next.mode === "custom" ? "After opening it, choose the allowed clubs on this tab." : ""}</p>
      <label>Deadline (UK time)
        <input type="datetime-local" id="nx-deadline" value="${escapeHtml(ui.next.deadline)}">
      </label>
      <button type="submit" class="go big full">Open gameweek ${D.cur.number + 1}</button>
    </form>`;
  return summary + few + nextForm + `
    <p class="center"><button type="button" class="link" data-act="undo">Undo these results</button></p>`;
}

/* override pick */

function overrideShell() {
  if (D.cur.mode === "off") return "";
  return `<section class="card" id="ov-card"><h2>Override a pick</h2><div id="ov"></div></section>`;
}
const ovPool = () => D.cur.mode === "custom"
  ? D.teams.filter((t) => D.allowed.has(t.id))
  : D.teams.filter((t) => t.active && NORMAL_LEAGUES.includes(t.league));

function renderOverride() {
  const el = $("#ov");
  if (!el) return;
  const o = ui.ov;
  const aliveE = aliveEntries().filter((e) => prof(e.player_id))
    .sort((a, b) => byName(prof(a.player_id).display_name, prof(b.player_id).display_name));
  if (o.player && !aliveE.some((e) => e.player_id === o.player)) Object.assign(o, { player: null, league: null, selected: null });

  let step = "";
  if (o.player) {
    const pk = D.pkBy.get(o.player);
    const cur = pk && pk.team_id != null ? D.tById.get(pk.team_id) : null;
    const pool = ovPool();
    const usedNote = (t) => (o.used.has(t.id) ? `Used GW${o.used.get(t.id)}` : "");
    const grid = (list) => `<div class="teams">${list.slice().sort((a, b) => byName(a.name, b.name)).map((t) =>
      tile(t, { act: "ov-team", selected: t.id === o.selected, note: o.used.has(t.id) ? usedNote(t) : (cur && cur.id === t.id ? "Current pick" : ""),
        disabled: o.used.has(t.id) })).join("")}</div>`;
    let chooser;
    if (D.cur.mode === "custom") {
      chooser = pool.length ? LEAGUES.map(([c, n]) => [n, pool.filter((t) => t.league === c)]).filter(([, l]) => l.length)
        .map(([n, l]) => `<h4>${n}</h4>${grid(l)}`).join("") : `<p class="muted">No clubs are allowed this week yet.</p>`;
    } else if (!o.league) {
      chooser = `<div class="leagues">${NORMAL_LEAGUES.map((c) => `
        <button type="button" class="league" data-act="ov-league" data-lg="${c}">
          <span class="league-name">${LEAGUE_NAME[c]}</span></button>`).join("")}</div>`;
    } else {
      chooser = `<div class="row between picker-nav">
          <button type="button" class="secondary" data-act="ov-back">← All leagues</button>
          <h3>${LEAGUE_NAME[o.league]}</h3></div>${grid(pool.filter((t) => t.league === o.league))}`;
    }
    const sel = o.selected ? D.tById.get(o.selected) : null;
    step = `
      ${o.warn ? `<p class="msg error">${escapeHtml(o.warn)}</p>` : ""}
      <p class="ov-now">${pname(o.player)}: ${cur ? `picked <strong>${escapeHtml(cur.name)}</strong>` : "<strong>no pick</strong>"}</p>
      ${chooser}
      ${sel ? `<div class="ov-confirm">
          <p><strong>Set ${pname(o.player)}'s pick to ${escapeHtml(sel.name)}?</strong></p>
          <div class="bar-buttons">
            <button type="button" class="secondary" data-act="ov-cancel">Cancel</button>
            <button type="button" class="go" data-act="ov-save">Set pick</button>
          </div></div>` : ""}
      ${cur ? `<p><button type="button" class="secondary full" data-act="ov-remove">Remove ${pname(o.player)}'s pick</button></p>` : ""}`;
  }

  const q = o.q.trim().toLowerCase();
  el.innerHTML = `
    <p class="muted small">Ignores the deadline. Only players still in are listed.</p>
    <label>Find a player
      <input type="search" id="ov-q" autocomplete="off" maxlength="60" value="${escapeHtml(o.q)}">
    </label>
    <label>Player
      <select id="ov-player">${ovOptions(aliveE, q)}</select>
    </label>
    ${step}`;
}
function ovOptions(aliveE, q) {
  const opts = aliveE.filter((e) => e.player_id === ui.ov.player || !q || prof(e.player_id).display_name.toLowerCase().includes(q))
    .map((e) => {
      const pk = D.pkBy.get(e.player_id);
      const t = pk && pk.team_id != null ? D.tById.get(pk.team_id) : null;
      return `<option value="${e.player_id}"${e.player_id === ui.ov.player ? " selected" : ""}>${pname(e.player_id)} (${t ? escapeHtml(teamName(t)) : "no pick"})</option>`;
    });
  return `<option value="">Choose a player…</option>${opts.join("")}`;
}
async function loadUsed(playerId) {
  ui.ov.used = new Map();
  ui.ov.warn = "";
  let r;
  try {
    r = await sb.from("picks").select("team_id,gameweek_id")
      .eq("game_id", D.active.id).eq("player_id", playerId).not("team_id", "is", null);
  } catch { r = { error: true }; }
  if (ui.ov.player !== playerId) return;
  if (r.error) {
    ui.ov.warn = "Couldn't check which clubs this player has already used, so none are greyed out. The server still refuses a repeat.";
  } else {
    const num = new Map(D.gws.map((g) => [g.id, g.number]));
    for (const x of r.data || []) if (x.gameweek_id !== D.cur.id) ui.ov.used.set(x.team_id, num.get(x.gameweek_id) || "?");
  }
  renderOverride();
}

/* live countdown, and refresh at the deadline */

function tick() {
  if (!D.cur) return;
  const left = Date.parse(D.cur.deadline) - nowMs();
  const el = $("#wk-left");
  if (el && renderedPhase === "before" && D.cur.mode !== "off") el.innerHTML = left > 0 ? `Time left: <strong>${fmtLeft(left)}</strong>` : "";
  // Re-fetch once the deadline passes, and keep trying every 15 seconds if that fails
  if (renderedPhase === "before" && left <= 0 && !busy && !running && Date.now() - lastDeadlineTry > 15000) {
    lastDeadlineTry = Date.now();
    refresh().catch(() => {});
  }
}
setInterval(tick, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !D.profiles || Date.now() - lastLoad < 60000) return;
  const f = document.activeElement;
  if (document.querySelector("dialog[open]") || (f && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName))) return;
  refresh().catch(() => {});
});

/* ----- Players ----- */

const PLAYER_FILTERS = [["all", "All"], ["alive", "In"], ["out", "Out"], ["wait", "Awaiting payment"], ["ready", "Not in game"]];

function renderPlayers() {
  const refPrefix = D.settings.pay_ref_prefix ?? "";
  const all = D.profiles.map((p) => ({ p, s: playerStatus(p), ref: payRef(refPrefix, p) }));
  $("#count").textContent = `(${D.profiles.length})`;
  const n = (k) => (k === "all" ? all.length : all.filter((x) => x.s === k).length);
  $("#pl-chips").innerHTML = PLAYER_FILTERS.map(([k, label]) => chip("p-filter", "f", k, `${label} (${n(k)})`, ui.pf === k)).join("");
  const q = ui.pq.trim().toLowerCase();
  const rows = all.filter((x) => (ui.pf === "all" || x.s === ui.pf)
    && (!q || x.p.display_name.toLowerCase().includes(q) || x.p.email.toLowerCase().includes(q) || x.ref.toLowerCase().includes(q)));
  $("#pl-list").innerHTML = rows.length ? rows.map(({ p, s, ref }) => `
    <button type="button" class="prow" data-act="p-open" data-id="${p.id}">
      <span class="prow-main">
        <span class="prow-name">${escapeHtml(p.display_name)}${p.role === "host" ? ' <span class="badge host">Host</span>' : ""}</span>
        <span class="muted small prow-email">${escapeHtml(p.email)}</span>
        <span class="small">Ref: ${escapeHtml(ref)}</span>
      </span>
      <span class="prow-side">
        <span class="prow-credit">${p.credit}<span class="muted small"> credit</span></span>
        ${statusBadge(s)}
      </span>
    </button>`).join("")
    : `<p class="muted">${D.profiles.length ? "No players match." : "No players yet."}${!D.active && ["alive", "out"].includes(ui.pf) ? " There is no game running." : ""}</p>`;
}

/* ----- Sheet (player or club detail) ----- */

function openSheet(kind, id) {
  ui.sheet = { kind, id };
  ui.opener = lastKey;
  say($("#sheet-msg"), "");
  renderSheet(true);
  if (!$("#sheet").open) $("#sheet").showModal();
  $("#sheet-title").focus();
}
function closeSheet() { if ($("#sheet").open) $("#sheet").close(); }
$("#sheet").addEventListener("close", () => {
  ui.sheet = null;
  say($("#sheet-msg"), ""); say($("#sheet-err"), "");
  // The browser returns focus to the opener; if the list was re-drawn meanwhile, find its twin
  if (focusLost() && ui.opener) { const el = document.querySelector(ui.opener); if (el) el.focus(); }
});
$("#sheet-close").addEventListener("click", closeSheet);
$("#sheet").addEventListener("click", (e) => { if (e.target === $("#sheet")) closeSheet(); });

function renderSheet(fresh) {
  const s = ui.sheet;
  if (!s) return;
  const dlg = $("#sheet"), top = fresh ? 0 : dlg.scrollTop;
  if (s.kind === "player") {
    const p = prof(s.id);
    if (!p) return closeSheet();
    $("#sheet-title").textContent = p.display_name;
    $("#sheet-body").innerHTML = playerSheet(p);
    fetchLog(p.id);
  } else {
    const t = s.id === "new" ? null : D.tById.get(s.id);
    if (s.id !== "new" && !t) return closeSheet();
    $("#sheet-title").textContent = t ? t.name : "Add club";
    $("#sheet-body").innerHTML = clubForm(t);
  }
  dlg.scrollTop = top;
}

function playerSheet(p) {
  const st = playerStatus(p), e = D.eById.get(p.id), g = D.active;
  const isMe = p.id === me.id;
  const ref = payRef(D.settings.pay_ref_prefix ?? "", p);
  let game = "";
  if (g) {
    if (!e) {
      game = p.credit >= 1
        ? `<button type="button" class="go full" data-act="enter">Enter into ${escapeHtml(g.name)} (takes 1 credit)</button>`
        : `<p class="muted">Not in the current game. Add credit first, then enter them.</p>`;
    } else {
      game = `<p>In ${escapeHtml(g.name)}: ${statusBadge(st)}</p>
        <button type="button" class="danger full" data-act="remove">Remove from game…</button>`;
    }
  } else game = `<p class="muted">No game running.</p>`;
  return `
    <p class="muted small sheet-meta">${escapeHtml(p.email)}<br>Ref: ${escapeHtml(ref)}</p>
    <p class="row">${p.role === "host" ? '<span class="badge host">Host</span>' : ""}${statusBadge(st)}
      <span class="sheet-credit">${p.credit} <span class="muted small">credit</span></span></p>

    <section class="sec">
      <h3>Add credit</h3>
      <div class="quick">
        ${[1, 2, 5].map((n) => `<button type="button" class="go" data-act="cr-quick" data-n="${n}">+${n}</button>`).join("")}
      </div>
      <form data-form="credit-add" novalidate>
        <div class="cols">
          <label>Games<input type="number" name="n" min="1" max="50" inputmode="numeric" value="1"></label>
          <label>Reason<input type="text" name="reason" maxlength="80" placeholder="Payment received" autocomplete="off"></label>
        </div>
        <button type="submit" class="go full">Add credit</button>
      </form>
    </section>

    <section class="sec">
      <h3>Remove credit</h3>
      <p class="muted small">For corrections, such as credit added by mistake.</p>
      <form data-form="credit-remove" novalidate>
        <div class="cols">
          <label>Games<input type="number" name="n" min="1" max="50" inputmode="numeric" value="1"></label>
          <label>Reason<input type="text" name="reason" maxlength="80" placeholder="Correction" autocomplete="off"></label>
        </div>
        <button type="submit" class="secondary full">Remove credit</button>
      </form>
    </section>

    <section class="sec"><h3>Game</h3>${game}</section>

    <section class="sec">
      <h3>Role</h3>
      <button type="button" class="secondary full" data-act="role" data-role="${p.role === "host" ? "player" : "host"}">${p.role === "host" ? "Make player…" : "Make host…"}</button>
      ${isMe ? '<p class="muted small">This is you.</p>' : ""}
    </section>

    <section class="sec">
      <h3>Credit history <span class="muted small">(last 10)</span></h3>
      <ul class="log" id="pl-log"><li class="muted">Loading…</li></ul>
    </section>`;
}

async function fetchLog(id) {
  const { data, error } = await sb.from("credit_log").select("change,reason,created_at")
    .eq("player_id", id).order("created_at", { ascending: false }).limit(10);
  const el = $("#pl-log");
  if (!el || !ui.sheet || ui.sheet.kind !== "player" || ui.sheet.id !== id) return;
  el.innerHTML = error ? `<li class="muted">Couldn't load the history.</li>`
    : (data || []).length ? data.map((r) => `
        <li><span class="log-date">${escapeHtml(fmtShort(r.created_at))}</span>
          <strong class="${r.change > 0 ? "plus" : "minus"}">${r.change > 0 ? "+" : "−"}${Math.abs(r.change)}</strong>
          <span>${escapeHtml(r.reason)}</span></li>`).join("")
    : `<li class="muted">No credit changes yet.</li>`;
}

/* ----- Game ----- */

function endDefaults() {
  const alive = aliveEntries().map((e) => e.player_id);
  if (alive.length) return alive;
  // Nobody left: the people knocked out in the latest gameweek share the win
  const latest = D.gws.slice().reverse().find((g) => D.entries.some((e) => e.out_gameweek_id === g.id));
  return latest ? D.entries.filter((e) => e.out_gameweek_id === latest.id).map((e) => e.player_id) : [];
}

function renderGame() {
  const el = $("#tab-game");
  let html = "";
  if (!D.active) {
    const ready = D.profiles.filter((p) => p.credit >= 1).length;
    const wait = D.profiles.length - ready;
    html = `
      <form class="card" data-form="start-game" novalidate>
        <h2>Start a new game</h2>
        <p>${plural(ready, "player")} with credit will be entered and charged 1 credit; ${wait} awaiting payment.</p>
        <label>Game name <span class="muted small">(optional)</span>
          <input type="text" name="name" maxlength="60" autocomplete="off" value="${escapeHtml(ui.start.name)}">
        </label>
        <label>First deadline (UK time)
          <input type="datetime-local" name="deadline" value="${escapeHtml(ui.start.deadline)}">
        </label>
        <button type="submit" class="go big full">Start game…</button>
      </form>`;
  } else {
    const entries = D.entries, alive = entries.filter((e) => e.status === "alive").length;
    const out = entries.filter((e) => e.status === "out").length;
    const sr = ui.startResult;
    html = `
      ${sr ? `<p class="msg ok">Game started: ${plural(sr.entered, "player")} entered, ${sr.awaiting} awaiting payment.</p>` : ""}
      <section class="card">
        <h2>${escapeHtml(D.active.name)}</h2>
        <p class="muted small">Started ${escapeHtml(fmtDate(D.active.started_at))}</p>
        <div class="stats">
          <div><strong>${alive}</strong><span>alive</span></div>
          <div><strong>${out}</strong><span>out</span></div>
          <div><strong>${entries.length}</strong><span>total</span></div>
        </div>
        <h3>Gameweeks so far</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>GW</th><th>Type</th><th>Deadline</th><th>Status</th></tr></thead>
            <tbody>${D.gws.map((g) => `
              <tr><td>${g.number}</td><td>${escapeHtml(MODE_NAME[g.mode] || g.mode)}</td>
              <td>${escapeHtml(fmtDeadline(g.deadline))}</td>
              <td>${g.status === "open" ? "Open" : "Done"}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      </section>
      ${endForm()}`;
  }
  const fin = D.games.filter((g) => g.status === "finished");
  html += `
    <section class="card">
      <h2>History</h2>
      ${fin.length ? fin.map((g) => {
        const ws = (D.winners.get(g.id) || []).map((id) => pname(id));
        return `<div class="hist">
          <h3>${escapeHtml(g.name)}</h3>
          <p class="muted small">${escapeHtml(fmtDate(g.started_at))}${g.ended_at ? ` to ${escapeHtml(fmtDate(g.ended_at))}` : ""}</p>
          <p><strong>${ws.length === 1 ? "Winner" : "Winners"}:</strong> ${ws.length ? ws.join(", ") : "none recorded"}</p>
          ${g.winner_note ? `<p class="muted">${escapeHtml(g.winner_note)}</p>` : ""}</div>`;
      }).join("") : `<p class="muted">No finished games yet.</p>`}
    </section>`;
  el.innerHTML = html;
}

function endForm() {
  const ticks = ui.end.ticks;
  const rank = (e) => (ticks.has(e.player_id) ? 0 : e.status === "alive" ? 1 : 2);
  const list = D.entries.filter((e) => prof(e.player_id))
    .sort((a, b) => rank(a) - rank(b) || byName(prof(a.player_id).display_name, prof(b.player_id).display_name));
  return `
    <form class="card" data-form="end-game" novalidate>
      <h2>End game</h2>
      <p class="muted small">Tick the winner(s). Players still in are ticked for you${aliveEntries().length ? "" : "; nobody is left, so it's those knocked out in the last gameweek"}.</p>
      <div class="scrollbox tall" tabindex="0" role="group" aria-label="Winners">
        ${list.map((e) => `
          <label class="chk"><input type="checkbox" name="w" value="${e.player_id}"${ticks.has(e.player_id) ? " checked" : ""}>
            <span>${pname(e.player_id)} ${statusBadge(e.status)}</span></label>`).join("")}
      </div>
      <label>Note <span class="muted small">(optional)</span>
        <input type="text" name="note" maxlength="200" autocomplete="off" value="${escapeHtml(ui.end.note)}">
      </label>
      <button type="submit" class="danger big full">End game…</button>
    </form>`;
}

/* ----- Clubs ----- */

function renderClubs() {
  $("#cl-counts").innerHTML = LEAGUES.map(([c, n]) => {
    const have = D.teams.filter((t) => t.league === c && t.active).length;
    const want = EXPECTED[c];
    const diff = want == null ? 0 : have - want;
    const note = want == null ? "custom weeks only" : diff === 0 ? "as expected" : diff > 0 ? `${diff} too many` : `${-diff} missing`;
    return `<div class="count${diff ? " bad" : ""}"><strong>${c}</strong>
      <span class="count-n">${have}${want != null ? ` / ${want}` : ""}</span><span class="small">${note}</span></div>`;
  }).join("");

  const q = ui.cq.trim().toLowerCase();
  const list = $("#cl-list");
  list.innerHTML = LEAGUES.map(([c, n]) => {
    const rows = D.teams.filter((t) => t.league === c && (!q || t.name.toLowerCase().includes(q) || (t.short_name || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.active - a.active) || byName(a.name, b.name));
    if (!rows.length) return "";
    return `<section class="card"><h2>${n} <span class="muted small">(${rows.filter((t) => t.active).length} active)</span></h2>
      ${rows.map((t) => `
        <button type="button" class="crow${t.active ? "" : " inactive"}" data-act="c-edit" data-id="${t.id}">
          ${swatch(t)}
          <span class="crow-text"><span class="crow-name">${escapeHtml(t.name)}</span>
            <span class="muted small">${escapeHtml(t.short_name || "")}</span></span>
          ${t.active ? "" : '<span class="badge">Inactive</span>'}
        </button>`).join("")}</section>`;
  }).join("") || `<p class="muted">No clubs match.</p>`;
}

function clubForm(t) {
  const v = t || { name: "", short_name: "", league: "PL", colour1: "#1e7a4c", colour2: "#ffffff", active: true };
  return `
    <form data-form="club" data-id="${t ? t.id : "new"}" novalidate>
      <label>Name<input type="text" name="name" maxlength="60" autocomplete="off" value="${escapeHtml(v.name)}"></label>
      <label>Short name (max 12 characters)<input type="text" name="short" maxlength="12" autocomplete="off" value="${escapeHtml(v.short_name)}"></label>
      <label>League
        <select name="league">${LEAGUES.map(([c, n]) => `<option value="${c}"${v.league === c ? " selected" : ""}>${n}</option>`).join("")}</select>
      </label>
      <div class="cols">
        <label>Colour 1<input type="color" name="c1" value="${escapeHtml(hex(v.colour1, "#888888").slice(0, 7))}"></label>
        <label>Colour 2<input type="color" name="c2" value="${escapeHtml(hex(v.colour2, "#ffffff").slice(0, 7))}"></label>
      </div>
      <label class="chk"><input type="checkbox" name="active"${v.active ? " checked" : ""}><span>Active (shown to players)</span></label>
      <p class="muted small">Untick for a club that has left the league. It's hidden from pickers but past picks are kept.</p>
      <button type="submit" class="go full">${t ? "Save club" : "Add club"}</button>
    </form>`;
}

/* ----- Settings: chase emails ----- */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DEFAULT_SLOTS = [{ day: 3, hour: 9 }, { day: 4, hour: 9 }, { day: 5, hour: 9 }];
const PLACEHOLDERS = ["{name}", "{deadline}", "{gameweek}", "{link}"];
const fmtHour = (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
const slotKey = (s) => `${s.day}-${s.hour}`;
const sortSlots = (list) => list.slice().sort((a, b) => a.day - b.day || a.hour - b.hour);
const slotTime = (s) => `${DAYS[s.day - 1]} ${fmtHour(s.hour)}`;
const pickLink = () => pageUrl("pick.html");
const cleanSlots = (list) => (Array.isArray(list) ? list : []).map((s) => ({ day: Number(s.day), hour: Number(s.hour) }));

// Start the form from what's saved; keep unsaved edits across refreshes
function syncChase() {
  const c = ui.chase;
  if (!D.email || (c.init && !c.stale)) return;
  const saved = cleanSlots(D.email.send_slots);
  Object.assign(c, { init: true, stale: false, enabled: !!D.email.enabled, subject: D.email.subject || "", body: D.email.body || "",
    slots: sortSlots(saved.length ? saved : DEFAULT_SLOTS) });
}
function chaseDirty() {
  const c = ui.chase, e = D.email;
  return !!e && (c.enabled !== !!e.enabled || c.subject !== (e.subject || "") || c.body !== (e.body || "")
    || JSON.stringify(sortSlots(c.slots)) !== JSON.stringify(sortSlots(cleanSlots(e.send_slots))));
}

// Players who would get a chase right now: still in, no pick, open week that isn't a week off
function chaseTargets() {
  if (!D.active || !D.cur) return { n: 0, why: "No game is running." };
  if (D.cur.mode === "off") return { n: 0, why: "This gameweek is a Week off." };
  if (phase() !== "before") return { n: 0, why: "Picks have locked for this gameweek." };
  const n = aliveEntries().filter((e) => { const pk = D.pkBy.get(e.player_id); return !(pk && pk.team_id != null); }).length;
  return { n, why: n ? "" : "Everyone still in has picked." };
}

// Replace {name} etc. with sample values for the preview
function fillSample(text) {
  const open = D.cur && D.cur.status === "open";
  const deadline = fmtDeadline(open ? D.cur.deadline : ukLocalToIso(nextFridayLocal(nowMs())));
  const vals = { "{name}": me.display_name, "{deadline}": deadline, "{gameweek}": String(D.cur ? D.cur.number : 1), "{link}": pickLink() };
  return text.replace(/\{(name|deadline|gameweek|link)\}/g, (m) => vals[m]);
}
function previewHtml() {
  const c = ui.chase;
  return `<p class="pv-subject">${escapeHtml(fillSample(c.subject)) || '<span class="muted">(no subject)</span>'}</p>
    <div class="pv-body">${escapeHtml(fillSample(c.body)) || '<span class="muted">(empty)</span>'}</div>`;
}
function updateDirty() { const el = $("#ch-dirty"); if (el) el.hidden = !chaseDirty(); }
function updatePreview() { const el = $("#ch-preview"); if (el) el.innerHTML = previewHtml(); updateDirty(); }

// Notes about send times that can never fire (the usual deadline is Friday 5pm)
function slotNotesHtml() {
  return ui.chase.slots.filter((s) => s.day > 5 || (s.day === 5 && s.hour >= 17))
    .map((s) => `<p class="note-warn">${escapeHtml(slotTime(s))} is after the usual 5pm Friday deadline, so nothing will send.</p>`).join("");
}

// Checks on the link saved in the database (what the emails will actually use)
function linkWarnings() {
  const saved = String((D.email && D.email.pick_url) || "").trim();
  const note = (t) => `<p class="note-warn">${escapeHtml(t)}</p>`;
  if (!saved) return note("No link saved yet. Tap Save. Emails won't send until you do.");
  let out = "";
  if (/^http:\/\/(localhost|127\.)/i.test(saved)) out += note("Emails currently link to your PC (fine for testing). After the site is live, open Host \u2192 Settings there and tap Save.");
  if (saved !== pickLink()) out += note("Saved link differs from this site. Tap Save to update.");
  return out;
}

// "Wed 4 Nov, 9am" or "Sent now, Thu 5 Nov 2pm"
const slotDayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
function slotLabel(slot) {
  const m = /^(manual )?(\d{4})-(\d\d)-(\d\d) (\d\d)$/.exec(slot);
  if (!m) return slot;
  const p = Object.fromEntries(slotDayFmt.formatToParts(new Date(Date.UTC(+m[2], +m[3] - 1, +m[4]))).map((x) => [x.type, x.value]));
  const when = `${p.weekday} ${p.day} ${p.month}`;
  return m[1] ? `Sent now, ${when} ${fmtHour(+m[5])}` : `${when}, ${fmtHour(+m[5])}`;
}
function recentHtml() {
  if (!D.cur) return `<p class="muted">No gameweek is open, so there are no sends to show.</p>`;
  if (!D.emailLog) return `<p class="msg error">Couldn't load the send history.</p>`;
  const rows = Array.isArray(D.emailLog.slots) ? D.emailLog.slots : [];   // newest first, from the server
  if (!rows.length) return `<p class="muted">Nothing sent yet for Gameweek ${D.cur.number}.</p>`;
  return `<ul class="sends">${rows.map((r) => `<li>${escapeHtml(slotLabel(String(r.slot)))}: <strong>${plural(Number(r.count) || 0, "email")}</strong></li>`).join("")}</ul>`;
}

function renderChase() {
  const el = $("#chase");
  if (!el) return;
  const c = ui.chase;
  if (!D.email) {
    el.innerHTML = `<h2 id="ch-title">Chase emails</h2>
      <p class="msg error">Couldn't load the chase email settings. Tap Refresh on the This week tab to try again.</p>`;
    return;
  }
  const t = chaseTargets();
  const setup = c.setup ? `<p class="msg error">${escapeHtml(c.setup)}${/stage-5-setup/.test(c.setup) ? "" : " See guides/stage-5-setup.md."}</p>` : "";
  const rows = c.slots.map((s, i) => `
    <div class="slot-row">
      <label>Day
        <select id="ch-day-${i}" data-slot="${i}" data-k="day">${DAYS.map((d, k) => `<option value="${k + 1}"${s.day === k + 1 ? " selected" : ""}>${d}</option>`).join("")}</select>
      </label>
      <label>Time (UK)
        <select id="ch-hr-${i}" data-slot="${i}" data-k="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${s.hour === h ? " selected" : ""}>${fmtHour(h)}</option>`).join("")}</select>
      </label>
      <button type="button" class="secondary" data-act="ch-del" data-i="${i}" aria-label="Remove ${escapeHtml(slotTime(s))}">Remove</button>
    </div>`).join("");
  const res = c.result ? `<p class="msg ${c.result.type}">${c.result.stopped ? `<strong>Stopped early: ${escapeHtml(c.result.stopped)}</strong><br>` : ""}${escapeHtml(c.result.text)}</p>` : "";

  el.innerHTML = `
    <h2 id="ch-title">Chase emails</h2>
    <label class="chk"><input type="checkbox" id="ch-enabled"${c.enabled ? " checked" : ""}><span>Send chase emails</span></label>
    <p class="muted small">Only to players still in who haven't picked. Never in a Week off.</p>

    <h3>Send times <span class="muted small">(UK time)</span></h3>
    ${rows || `<p class="muted">No times set. Saving will use the defaults: Wednesday, Thursday and Friday at 9am.</p>`}
    <div id="ch-slotnotes">${slotNotesHtml()}</div>
    <button type="button" class="secondary full" data-act="ch-add">Add a time</button>

    <h3>The email</h3>
    <label>Subject
      <input type="text" id="ch-subject" maxlength="200" autocomplete="off" value="${escapeHtml(c.subject)}">
    </label>
    <p class="muted small" id="ch-ph-help">Tap to add to the subject or message, wherever you last typed:</p>
    <div class="chips" role="group" aria-labelledby="ch-ph-help">
      ${PLACEHOLDERS.map((p) => `<button type="button" class="chip" data-act="ch-ph" data-ph="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join("")}
    </div>
    <label>Message
      <textarea id="ch-body" rows="8" maxlength="4000">${escapeHtml(c.body)}</textarea>
    </label>
    <h3>Preview</h3>
    <div class="preview" id="ch-preview">${previewHtml()}</div>
    <p class="muted small">Pick link in the emails (set automatically when you save):</p>
    <p class="linktext">${escapeHtml(pickLink())}</p>
    ${linkWarnings()}

    <p class="note-warn" id="ch-dirty"${chaseDirty() ? "" : " hidden"}>You have unsaved changes. Test and chase emails use the saved version.</p>
    <button type="button" class="go full" data-act="ch-save">Save</button>

    <h3>Send now</h3>
    ${setup}
    <button type="button" class="secondary full" data-act="ch-test">Send me a test email</button>
    <p class="muted small">Sends one sample to ${escapeHtml(me.email)}.</p>
    <button type="button" class="go full" data-act="ch-now"${t.n ? "" : " disabled"}>Send chase now${t.n ? ` (${t.n})` : ""}</button>
    <p class="muted small">${t.n ? `${plural(t.n, "player")} still in ${t.n === 1 ? "hasn't" : "haven't"} picked.` : escapeHtml(`Not available: ${t.why}`)}</p>
    <div id="ch-result" role="status">${res}</div>

    <h3>Recent sends${D.cur ? ` <span class="muted small">(Gameweek ${D.cur.number})</span>` : ""}</h3>
    ${recentHtml()}`;
}

// Call the chase-emails function. Throws a plain sentence. If the server answered, it's a definite
// failure; if we never heard back, say the email may have gone out so nobody retries blindly.
async function chaseCall(mode) {
  let r;
  try { r = await sb.functions.invoke("chase-emails", { body: { mode } }); }
  catch { r = { error: { name: "FunctionsFetchError" } }; }
  const fail = (msg) => Object.assign(new Error(msg), { setup: /email isn.t set up/i.test(msg) });
  if (r.error) {
    const answered = r.error.name === "FunctionsHttpError" || !!(r.error.context && typeof r.error.context.json === "function");
    let msg = "";
    try { msg = (await r.error.context.json()).error || ""; } catch {}
    const status = r.error.context && r.error.context.status;
    const setup = /email isn.t set up/i.test(msg);
    if (mode === "now" && answered && status >= 500 && !setup) {
      throw fail("Something went wrong part-way. Some emails may have been sent. It's safe to try again: nobody is emailed twice within an hour.");
    }
    if (msg) throw fail(msg);
    if (answered) throw fail("The email service reported a problem. Check Recent sends to see whether anything went out before trying again.");
    throw fail(mode === "now"
      ? "We couldn't confirm what happened. Some emails may have been sent. Check Recent sends before trying again."
      : "We couldn't confirm what happened. The test email may not have been sent.");
  }
  if (r.data && r.data.error) throw fail(String(r.data.error));
  return r.data || {};
}

async function runChase(btn, mode) {
  const done = await act(btn, async () => {
    try {
      const r = await chaseCall(mode);
      ui.chase.setup = "";
      if (mode === "test") ui.chase.result = { text: `Test email sent to ${r.to || me.email}.`, type: "ok" };
      else if (r.skipped) ui.chase.result = { text: `Nothing was sent: ${String(r.skipped).replace(/[.]$/, "")}.`, type: "ok" };
      else {
        const failed = Number(r.failed) || 0, skippedRecent = Number(r.skipped_recent) || 0;
        const errs = Array.isArray(r.errors) ? r.errors.slice(0, 5).map(String) : [];
        const stopped = r.stopped ? (r.stopped === true ? "Brevo refused the emails or it ran out of time." : String(r.stopped)) : "";
        ui.chase.result = { type: failed || stopped || r.ok === false ? "error" : "ok", stopped,
          text: `Sent ${plural(Number(r.sent) || 0, "email")}.`
            + (skippedRecent ? ` ${skippedRecent} skipped: already emailed in the last hour.` : "")
            + (failed ? ` ${failed} failed${errs.length ? `: ${errs.join("; ")}` : ""}.` : "") };
      }
      return r;
    } catch (e) {
      if (e.setup) ui.chase.setup = e.message; else ui.chase.result = { text: e.message, type: "error" };
      renderChase();
      throw e;
    }
  }, () => (ui.chase.result.type === "ok" ? ui.chase.result.text : null));
  // Some emails failed: say so in the error style too (the action itself went through)
  if (done && ui.chase.result && ui.chase.result.type === "error") {
    flash(`${ui.chase.result.stopped ? `Stopped early: ${ui.chase.result.stopped} ` : ""}${ui.chase.result.text}`, "error");
  }
  return done;
}

async function saveChase(btn) {
  const c = ui.chase;
  const subject = c.subject.trim(), body = c.body.trim();
  if (!subject) return flash("Enter a subject for the email.", "error");
  if (!body) return flash("Enter the message for the email.", "error");
  const slots = c.slots.length ? c.slots : DEFAULT_SLOTS;
  const seen = new Set();
  for (const s of slots) {
    if (!Number.isInteger(s.day) || s.day < 1 || s.day > 7 || !Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23) return flash("One of the send times isn't valid.", "error");
    if (seen.has(slotKey(s))) return flash(`${slotTime(s)} is in the list twice.`, "error");
    seen.add(slotKey(s));
  }
  await act(btn, async () => {
    await write(sb.from("email_settings").update({ enabled: c.enabled, send_slots: sortSlots(slots), subject, body, pick_url: pickLink() })
      .eq("id", 1).select("id"));
    c.stale = true;
  }, "Chase email settings saved.");
}

async function chaseNow(btn) {
  const t = chaseTargets();
  if (!t.n) return flash(t.why || "Nobody to chase.", "error");
  const yes = await ask({
    title: `Email ${plural(t.n, "player")} now?`,
    body: `<p>Each player still in who hasn't picked gets the saved chase email straight away.</p>
      ${D.emailLog && D.emailLog.recent_players > 0 ? `<p class="muted small">(anyone emailed in the last hour is skipped automatically)</p>` : ""}`,
    ok: `Email ${plural(t.n, "player")}`,
  });
  if (yes) await runChase(btn, "now");
}

/* ---------- Actions ---------- */

// Checklist of players for the postponed / reopen dialogs
async function reopenDialog({ title, intro, ids, ticked }) {
  const rows = ids.map((id) => {
    const pk = D.pkBy.get(id);
    const t = pk && pk.team_id != null ? D.tById.get(pk.team_id) : null;
    return `<label class="chk" data-name="${escapeHtml((prof(id)?.display_name || "").toLowerCase())}">
      <input type="checkbox" value="${id}"${ticked ? " checked" : ""}>
      <span>${pname(id)} <span class="muted small">${t ? escapeHtml(teamName(t)) : "no pick"}</span></span></label>`;
  }).join("");
  const picked = (r) => [...r.querySelectorAll("label.chk:not([hidden]) input[type=checkbox]:checked")].map((c) => c.value);
  const ask1 = ask({
    title, ok: "Reopen picks",
    body: `<p class="muted small">${intro}</p>
      ${ids.length > 8 ? `<label>Find a player<input type="search" id="rp-q" autocomplete="off"></label>` : ""}
      <div class="scrollbox" role="group" aria-label="Players">${rows}</div>
      <label>New deadline (UK time)
        <input type="datetime-local" id="rp-deadline" value="${isoToUkLocal(new Date(nowMs() + 86400000).toISOString())}">
      </label>`,
    validate: (r) => {
      if (!picked(r).length) return "Tick at least one player.";
      const iso = ukLocalToIso($("#rp-deadline", r).value);
      if (!iso) return "Enter a valid deadline (UK time).";
      if (Date.parse(iso) <= nowMs()) return "The new deadline must be in the future.";
      return "";
    },
  });
  updateReopenCount();
  const root = await ask1;
  if (!root) return;
  // Only players still showing in the list count, so a search can't leave hidden ticks behind
  const players = picked(root);
  const deadline = ukLocalToIso($("#rp-deadline", root).value);
  await act(null, () => rpc("host_reopen_picks", { p_player_ids: players, p_deadline: deadline }),
    (n) => `${plural(Number(n) || players.length, "player")} can pick again until ${fmtDeadline(deadline)}.`);
}
// Live "N selected" on the dialog's button (counts ticked rows that are showing)
function updateReopenCount() {
  const body = $("#dlg-body");
  if (!$("#rp-deadline", body)) return;
  const n = body.querySelectorAll("label.chk:not([hidden]) input[type=checkbox]:checked").length;
  const ok = $("#dlg-ok");
  ok.textContent = n ? `Reopen ${plural(n, "player")}` : "Reopen picks";
  ok.disabled = n === 0;
}
// Filter box inside the reopen dialog (hides rows, keeps their ticks)
document.addEventListener("input", (e) => {
  if (e.target.id !== "rp-q") return;
  const q = e.target.value.trim().toLowerCase();
  for (const row of $("#dlg-body").querySelectorAll("label.chk")) row.hidden = !!q && !row.dataset.name.includes(q);
  updateReopenCount();
});
document.addEventListener("change", (e) => {
  if (e.target.type === "checkbox" && e.target.closest("#dlg-body")) updateReopenCount();
});

async function saveWeek(btn) {
  const w = ui.week, gw = D.cur;
  if (!w.deadline) return flash("Enter a deadline (UK time).", "error");
  let deadline = null;
  if (w.deadline !== w.origDeadline) {
    deadline = ukLocalToIso(w.deadline);
    if (!deadline) return flash("That isn't a valid UK time. Clocks skip an hour when they go forward, so pick another time.", "error");
    if (Date.parse(deadline) <= nowMs()) return flash("The new deadline must be in the future.", "error");
  }
  if (w.mode === "custom" && !w.custom.size) return flash("Choose at least one club for a Custom week.", "error");

  // Picks that would no longer be allowed are removed by the server, so warn first
  const made = D.picks.filter((p) => p.team_id != null && D.eById.get(p.player_id)?.status === "alive");
  const ok = (t) => w.mode === "custom" ? w.custom.has(t.id) : t.active && t.league !== "NL";
  const gone = w.mode === "off" ? made.length : made.filter((p) => !(D.tById.get(p.team_id) && ok(D.tById.get(p.team_id)))).length;
  if (gone) {
    const yes = await ask({
      title: w.mode === "off" ? "Switch to a week off?" : "Remove some picks?",
      body: `<p><strong>${plural(gone, "pick")}</strong> will be removed${w.mode === "off" ? "" : " because those clubs aren't allowed in this week"}. Those players will need to pick again.</p>`,
      ok: "Save and remove picks", danger: true,
    });
    if (!yes) return;
  }
  await act(btn, async () => {
    const r = await rpc("host_update_gameweek", { p_mode: w.mode, p_deadline: deadline, p_team_ids: w.mode === "custom" ? [...w.custom] : null });
    w.stale = true;
    return r;
  }, (r) => {
    const n = r && r.removed_picks;
    return `Saved.${n ? ` ${plural(n, "pick was", "picks were")} removed, so those players need to pick again.` : ""}`;
  });
}

async function confirmResults(btn) {
  const s = weekStats();
  const yes = await ask({
    title: "Confirm results?",
    body: `<p class="big-line"><strong>${plural(s.out, "player")} will go out.</strong></p>
      <p>${s.stay} ${s.stay === 1 ? "stays" : "stay"} in.${s.stay === 0 ? " Nobody would be left in." : ""}</p>
      <p class="muted small">You can undo this straight afterwards if it's a mistake.</p>`,
    ok: "Confirm results", danger: true,
  });
  if (!yes) return;
  await act(btn, () => rpc("host_confirm_results"),
    (r) => `Results confirmed: ${r.out} out, ${r.still_in} still in.`);
}

async function postpone(btn) {
  const id = Number(btn.dataset.id);
  const x = weekStats().teams.find((t) => t.id === id);
  if (!x) return;
  await reopenDialog({
    title: `Postponed: ${x.name}`,
    intro: `Their ${escapeHtml(x.name)} pick is cleared and they pick again before the new deadline. Untick anyone who shouldn't be reopened.`,
    ids: x.players.slice().sort((a, b) => byName(prof(a)?.display_name || "", prof(b)?.display_name || "")), ticked: true,
  });
}

async function copySummary(btn) {
  const text = btn.dataset.text;
  try {
    await navigator.clipboard.writeText(text);
    flash("Copied.", "ok");
  } catch {
    const el = $("#summary");   // select the text so it can be copied by hand
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    flash("Couldn't copy automatically. The text is selected, so you can copy it yourself.", "error");
  }
}

async function addCredit(btn, n, reason) {
  const p = prof(ui.sheet.id);
  await act(btn, () => rpc("host_add_credit", { p_player: p.id, p_change: n, p_reason: reason || null }),
    (c) => `${n > 0 ? "Added" : "Removed"} ${Math.abs(n)} ${n > 0 ? "to" : "from"} ${p.display_name}. They now have ${c}.`);
}

async function enterPlayer(btn) {
  const p = prof(ui.sheet.id);
  await act(btn, () => rpc("host_enter_player", { p_player: p.id }), `${p.display_name} is now in ${D.active.name}.`);
}

async function removePlayer(btn) {
  const p = prof(ui.sheet.id);
  const root = await ask({
    title: `Remove ${p.display_name}?`,
    body: `<p>They'll be taken out of <strong>${escapeHtml(D.active.name)}</strong> and their picks in this game are deleted. This can't be undone.</p>
      <label class="chk"><input type="checkbox" id="refund" checked><span>Refund 1 credit</span></label>`,
    ok: "Remove from game", danger: true,
  });
  if (!root) return;
  const refund = $("#refund", root).checked;
  await act(btn, () => rpc("host_remove_player", { p_player: p.id, p_refund: refund }),
    `${p.display_name} was removed${refund ? " and refunded 1 credit" : ""}.`);
}

async function setRole(btn) {
  const p = prof(ui.sheet.id), role = btn.dataset.role;
  const self = p.id === me.id;
  const yes = await ask({
    title: role === "host" ? `Make ${p.display_name} a host?` : `Make ${p.display_name} a player?`,
    body: role === "host"
      ? `<p>Hosts can see everyone's picks, change credit and run the game.</p>`
      : `<p>They will lose host access.${self ? " <strong>That's you, so you'll lose it straight away.</strong>" : ""}</p>`,
    ok: role === "host" ? "Make host" : "Make player", danger: role === "player",
  });
  if (!yes) return;
  const done = await act(btn, () => rpc("host_set_role", { p_player: p.id, p_role: role }),
    `${p.display_name} is now a ${role}.`);
  if (done && self && role === "player") location.replace("pick.html");
}

const ACTIONS = {
  refresh: async (b) => {
    busy = true; b.disabled = true;
    try { await refresh(); flash("Up to date."); }
    catch { flash("Couldn't refresh. Please check your connection and try again.", "error"); }
    finally { busy = false; if (b.isConnected) b.disabled = false; }
  },
  "wk-lg": (b) => { ui.week.lg = b.dataset.lg; renderWeek(); },
  "wk-toggle": (b) => {
    const id = Number(b.dataset.id), c = ui.week.custom;
    if (!c.delete(id)) c.add(id);
    renderWkTeams();
  },
  "wk-all": () => { for (const t of shownTeams()) ui.week.custom.add(t.id); renderWkTeams(); },
  "wk-none": () => { for (const t of shownTeams()) ui.week.custom.delete(t.id); renderWkTeams(); },
  "wk-save": saveWeek,

  "res-set": (b) => {
    const id = Number(b.dataset.id), target = b.dataset.result;
    const cur = weekStats().teams.find((t) => t.id === id)?.result;
    return act(b, () => rpc("host_set_team_result", { p_team_id: id, p_result: cur === target ? "pending" : target }), null, { light: true });
  },
  "res-post": postpone,
  "res-reopen": () => reopenDialog({
    title: "Reopen picks",
    intro: "Choose the players who should pick again, for example because their match was postponed. Their current pick is cleared.",
    ids: aliveEntries().map((e) => e.player_id).sort((a, b) => byName(prof(a)?.display_name || "", prof(b)?.display_name || "")),
    ticked: false,
  }),
  "res-confirm": confirmResults,
  copy: copySummary,
  undo: async (b) => {
    const yes = await ask({
      title: `Undo Gameweek ${D.cur.number} results?`,
      body: `<p>Anyone knocked out by these results goes back in, and the gameweek reopens so you can fix the results.</p>`,
      ok: "Undo results", danger: true,
    });
    if (yes) await act(b, () => rpc("host_undo_results"), "Results undone. Fix them below, then confirm again.");
  },

  "ov-league": (b) => { ui.ov.league = b.dataset.lg; ui.ov.selected = null; renderOverride(); },
  "ov-back": () => { ui.ov.league = null; ui.ov.selected = null; renderOverride(); },
  "ov-team": (b) => { const id = Number(b.dataset.id); ui.ov.selected = ui.ov.selected === id ? null : id; renderOverride(); },
  "ov-cancel": () => { ui.ov.selected = null; renderOverride(); },
  "ov-save": (b) => {
    const { player, selected } = ui.ov, t = D.tById.get(selected);
    return act(b, async () => {
      await rpc("host_set_pick", { p_player: player, p_team_id: selected });
      ui.ov = { q: "", player: null, league: null, selected: null, used: new Map() };
    }, `${prof(player).display_name}'s pick is now ${t.name}.`);
  },
  "ov-remove": async (b) => {
    const player = ui.ov.player, name = prof(player).display_name;
    const yes = await ask({
      title: `Remove ${name}'s pick?`,
      body: `<p>They'll have no pick for this gameweek. If picks are locked, they go out unless you reopen their pick.</p>`,
      ok: "Remove pick", danger: true,
    });
    if (yes) await act(b, async () => {
      await rpc("host_set_pick", { p_player: player, p_team_id: null });
      ui.ov = { q: "", player: null, league: null, selected: null, used: new Map() };
    }, `${name}'s pick was removed.`);
  },

  "p-filter": (b) => { ui.pf = b.dataset.f; renderPlayers(); },
  "p-open": (b) => openSheet("player", b.dataset.id),
  "cr-quick": (b) => addCredit(b, Number(b.dataset.n), ""),
  enter: enterPlayer,
  remove: removePlayer,
  role: setRole,

  "ch-add": () => {
    const have = new Set(ui.chase.slots.map(slotKey));
    for (const hour of [9, 12, 15, 8, 10, 11, 13, 14, 16, 18, 19, 20, 7, 6, 5, 4, 3, 2, 1, 0, 17, 21, 22, 23]) {
      for (const day of [3, 4, 5, 1, 2, 6, 7]) {
        if (have.has(`${day}-${hour}`)) continue;
        ui.chase.slots = sortSlots([...ui.chase.slots, { day, hour }]);
        renderChase();
        return;
      }
    }
    flash("Every time is already in the list.", "error");
  },
  "ch-del": (b) => { ui.chase.slots.splice(Number(b.dataset.i), 1); renderChase(); },
  "ch-ph": (b) => {
    const key = ui.chase.target === "subject" ? "subject" : "body";
    const field = $(key === "subject" ? "#ch-subject" : "#ch-body");
    field.setRangeText(b.dataset.ph, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, "end");
    ui.chase[key] = field.value;
    field.focus();
    updatePreview();
  },
  "ch-save": saveChase,
  "ch-test": (b) => runChase(b, "test"),
  "ch-now": chaseNow,

  "c-edit": (b) => openSheet("club", Number(b.dataset.id)),
  "c-new": () => openSheet("club", "new"),
};

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act], [data-tab], [data-goto]");
  if (!t || t.disabled) return;
  if (t.dataset.tab) return setTab(t.dataset.tab);
  if (t.dataset.goto) { closeSheet(); return setTab(t.dataset.goto); }
  if (busy) return;
  const fn = ACTIONS[t.dataset.act];
  if (fn) fn(t, e);
});

/* ---------- Typing and choosing ---------- */

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "pl-q") { ui.pq = t.value; renderPlayers(); }
  else if (t.id === "cl-q") { ui.cq = t.value; renderClubs(); }
  else if (t.id === "wk-q") { ui.week.q = t.value; renderWkTeams(); }
  else if (t.id === "wk-deadline") ui.week.deadline = t.value;
  else if (t.id === "nx-deadline") ui.next.deadline = t.value;
  else if (t.id === "ov-q") { ui.ov.q = t.value; $("#ov-player").innerHTML = ovOptions(
    aliveEntries().filter((x) => prof(x.player_id)).sort((a, b) => byName(prof(a.player_id).display_name, prof(b.player_id).display_name)),
    t.value.trim().toLowerCase()); }
  else if (t.form && t.form.dataset.form === "start-game") ui.start[t.name === "name" ? "name" : "deadline"] = t.value;
  else if (t.form && t.form.dataset.form === "end-game" && t.name === "note") ui.end.note = t.value;
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "wk-mode") { ui.week.mode = t.value; renderWeek(); }
  else if (t.name === "nx-mode") {
    ui.next.mode = t.value;
    $("#nx-hint").textContent = t.value === "custom" ? "After opening it, choose the allowed clubs on this tab." : "";
  } else if (t.id === "ov-player") {
    Object.assign(ui.ov, { player: t.value || null, league: null, selected: null, used: new Map(), warn: "" });
    renderOverride();
    if (ui.ov.player) loadUsed(ui.ov.player);
  } else if (t.form && t.form.dataset.form === "end-game" && t.name === "w") {
    ui.end.touched = true;
    ui.end.ticks[t.checked ? "add" : "delete"](t.value);
  }
});
document.addEventListener("toggle", (e) => { if (e.target.id === "wk-nl") ui.week.nlOpen = e.target.open; }, true);

document.addEventListener("focusin", (e) => {
  if (e.target.id === "ch-subject") ui.chase.target = "subject";
  else if (e.target.id === "ch-body") ui.chase.target = "body";
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "ch-subject") { ui.chase.subject = t.value; updatePreview(); }
  else if (t.id === "ch-body") { ui.chase.body = t.value; updatePreview(); }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "ch-enabled") { ui.chase.enabled = t.checked; updateDirty(); return; }
  if (t.dataset && t.dataset.slot != null && t.closest("#chase")) {
    const i = Number(t.dataset.slot), s = ui.chase.slots[i];
    const next = { ...s, [t.dataset.k]: Number(t.value) };
    if (ui.chase.slots.some((o, j) => j !== i && slotKey(o) === slotKey(next))) {
      t.value = String(s[t.dataset.k]);   // already in the list: put it back
      return flash(`${slotTime(next)} is already in the list.`, "error");
    }
    ui.chase.slots[i] = next;
    $("#ch-slotnotes").innerHTML = slotNotesHtml();
    updateDirty();
  }
});

/* ---------- Forms ---------- */

const FORMS = {
  "add-nl": async (f) => {
    const club = readClub(f, "NL");
    if (club.error) return flash(club.error, "error");
    const w = ui.week;
    await act($("button[type=submit]", f), async () => {
      const rows = await write(sb.from("teams").insert(club.row).select("id"));
      w.custom.add(rows[0].id);
      w.nlOpen = true;
    }, `${club.row.name} added to Non-league and allowed this week. Remember to save.`);
  },

  "next-gw": async (f) => {
    const n = ui.next;
    let deadline = null;
    if (n.deadline !== n.def) {
      deadline = ukLocalToIso(n.deadline);
      if (!deadline) return flash("Enter a valid deadline (UK time).", "error");
      if (Date.parse(deadline) <= nowMs()) return flash("The deadline must be in the future.", "error");
    }
    const mode = n.mode;
    await act($("button[type=submit]", f), async () => {
      await rpc("host_next_gameweek", { p_mode: mode, p_deadline: deadline });
      ui.next = { mode: "normal", deadline: "", def: "" };
    }, () => `Gameweek ${D.cur.number} is open.${mode === "custom" ? " Now choose the allowed clubs." : ""}`);
  },

  "credit-add": (f) => creditForm(f, 1),
  "credit-remove": (f) => creditForm(f, -1),

  "start-game": async (f) => {
    const name = f.name.value.trim(), s = ui.start;
    let deadline = null;
    if (s.deadline !== s.def) {
      deadline = ukLocalToIso(s.deadline);
      if (!deadline) return flash("Enter a valid first deadline (UK time).", "error");
      if (Date.parse(deadline) <= nowMs()) return flash("The first deadline must be in the future.", "error");
    }
    const ready = D.profiles.filter((p) => p.credit >= 1).length, wait = D.profiles.length - ready;
    const when = fmtDeadline(deadline || ukLocalToIso(s.def));
    const yes = await ask({
      title: "Start the game?",
      body: `<p><strong>${plural(ready, "player")}</strong> will be entered and charged 1 credit each. ${wait} awaiting payment will not be entered.</p>
        <p>First deadline: ${escapeHtml(when)} (UK time).</p>
        ${name ? `<p>Name: ${escapeHtml(name)}</p>` : ""}`,
      ok: "Start game",
    });
    if (!yes) return;
    await act($("button[type=submit]", f), async () => {
      const r = await rpc("host_start_game", { p_name: name || null, p_first_deadline: deadline });
      ui.startResult = r;
      ui.start = { name: "", deadline: "", def: "" };
      ui.week.gwId = null;
      return r;
    }, (r) => `Game started: ${plural(r.entered, "player")} entered, ${r.awaiting} awaiting payment.`);
  },

  "end-game": async (f) => {
    const ids = [...ui.end.ticks];
    const note = ui.end.note.trim();
    const names = ids.map((id) => pname(id));
    const yes = await ask({
      title: "End the game?",
      body: `<p>${ids.length ? `<strong>${plural(ids.length, "winner")}</strong>: ${names.join(", ")}.` : "<strong>No winners selected.</strong>"}</p>
        <p>This closes ${escapeHtml(D.active.name)}. It can't be undone.</p>`,
      ok: "End game", danger: true,
    });
    if (!yes) return;
    await act($("button[type=submit]", f), async () => {
      await rpc("host_end_game", { p_winner_ids: ids, p_note: note || null });
      ui.startResult = null;
      ui.end = { gameId: null, ticks: new Set(), note: "", touched: false };
    }, "Game ended. You can start a new one whenever you're ready.");
  },

  club: async (f) => {
    const id = f.dataset.id;
    const club = readClub(f, f.league.value, true);
    if (club.error) return flash(club.error, "error");
    await act($("button[type=submit]", f), async () => {
      await write(id === "new" ? sb.from("teams").insert(club.row).select("id")
        : sb.from("teams").update(club.row).eq("id", Number(id)).select("id"));
      closeSheet();
    }, `${club.row.name} saved.`);
  },
};

// Read and check a club form (add-club, edit-club and the non-league mini form)
function readClub(f, league, withActive = false) {
  const name = f.name.value.trim(), short = f.short.value.trim();
  const c1 = f.c1.value.toLowerCase(), c2 = f.c2.value.toLowerCase();
  if (!name) return { error: "Enter the club's name." };
  if (!short) return { error: "Enter a short name." };
  if (short.length > 12) return { error: "The short name can be 12 characters at most." };
  if (!LEAGUE_NAME[league]) return { error: "Choose a league." };
  if (!/^#[0-9a-f]{6}$/.test(c1) || !/^#[0-9a-f]{6}$/.test(c2)) return { error: "Colours must look like #1e7a4c." };
  const row = { name, short_name: short, league, colour1: c1, colour2: c2 };
  if (withActive) row.active = f.active.checked;
  return { row };
}

async function creditForm(f, sign) {
  const n = Number(f.n.value);
  if (!Number.isInteger(n) || n < 1 || n > 50) return flash("Enter a whole number of games, from 1 to 50.", "error");
  const p = prof(ui.sheet.id);
  if (sign < 0 && n > p.credit) return flash(`${p.display_name} only has ${plural(p.credit, "game")} of credit.`, "error");
  await addCredit($("button[type=submit]", f), sign * n, f.reason.value.trim());
}

document.addEventListener("submit", (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  if (busy) return;
  FORMS[f.dataset.form](f);
});

/* ---------- Payment details and invites (unchanged behaviour) ---------- */

const payForm = $("#pay-form");
payForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $(".msg", payForm);
  const sort = payForm.pay_sort_code.value.replace(/\D/g, "");
  const acct = payForm.pay_account_number.value.replace(/\D/g, "");
  const prefix = payForm.pay_ref_prefix.value.trim().toUpperCase();
  if (sort.length !== 6) return say(msg, "Sort code should be 6 digits.", "error");
  if (acct.length !== 8) return say(msg, "Account number should be 8 digits.", "error");
  if (!/^[A-Z0-9]{1,5}$/.test(prefix)) return say(msg, "Reference start should be 1–5 letters or numbers.", "error");

  const update = {
    pay_account_name: payForm.pay_account_name.value.trim(),
    pay_sort_code: sort.replace(/(\d\d)(\d\d)(\d\d)/, "$1-$2-$3"),
    pay_account_number: acct,
    pay_ref_prefix: prefix,
    pay_note: payForm.pay_note.value.trim(),
  };
  const { error } = await sb.from("app_settings").update(update).eq("id", 1);
  if (error) return say(msg, `Couldn't save: ${error.message}`, "error");
  Object.assign(D.settings, update);
  payForm.pay_sort_code.value = update.pay_sort_code;
  payForm.pay_ref_prefix.value = prefix;
  say(msg, "Saved. Players will see these details on their page.", "ok");
  renderPlayers();
});

const inviteForm = $("#invite-form");
inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $(".msg", inviteForm);
  const name = inviteForm.name.value.trim();
  const email = inviteForm.email.value.trim();
  if (!name || !email) return say(msg, "Enter a name and an email.", "error");

  const btn = $("button[type=submit]", inviteForm);
  btn.disabled = true; say(msg, "Sending invite…");
  const { error } = await sb.functions.invoke("invite-player", {
    body: { name, email, redirectTo: pageUrl("set-password.html") },
  });
  btn.disabled = false;
  if (error) {
    let text = "Invite failed.";
    try { text = (await error.context.json()).error || text; } catch {}
    return say(msg, text, "error");
  }
  say(msg, `Invite sent to ${email}. Ask them to check their spam folder if it doesn't arrive.`, "ok");
  inviteForm.reset();
  refresh().catch(() => {});
});

// Re-drawing replaces buttons, so each of these hands focus on to the matching new control
renderAll = keepFocus(renderAll); renderWeek = keepFocus(renderWeek); renderWkTeams = keepFocus(renderWkTeams);
renderOverride = keepFocus(renderOverride); renderChase = keepFocus(renderChase); renderPlayers = keepFocus(renderPlayers); renderClubs = keepFocus(renderClubs);
function keepFocus(fn) { return (...a) => withFocus(() => fn(...a)); }

/* ---------- Start ---------- */

async function start() {
  $("#error-text").textContent = "";
  $("#retry").hidden = true;
  try {
    await refresh();
  } catch {
    say($("#error-text"), "Sorry, we couldn't load the host screen. Please check your connection and try again.", "error");
    $("#retry").hidden = false;
    $("#loading").hidden = true;
    return;
  }
  for (const el of payForm.elements) if (el.name) el.value = D.settings[el.name] ?? "";
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch {}
  setTab(saved);
  $("#loading").hidden = true;
  $("#app").hidden = false;
}
$("#retry").addEventListener("click", start);
await start();
