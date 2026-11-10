// "My pick" screen: status, deadline countdown, two-step team picker, and the player's run.
import { sb, requireUser, $, say, escapeHtml, payRef } from "./app.js";

const LEAGUES = [
  ["PL", "Premier League"], ["CH", "Championship"], ["L1", "League One"],
  ["L2", "League Two"], ["NL", "Non-league"],
];
const LEAGUE_NAME = Object.fromEntries(LEAGUES);
const NORMAL_LEAGUES = ["PL", "CH", "L1", "L2"];   // custom weeks can also include NL

const me = await requireUser();
$("#hello").textContent = `Hello, ${me.display_name}`;
$("#credit").textContent =
  `Credit: ${me.credit} game${me.credit === 1 ? "" : "s"}${me.role === "host" ? " · You are a host" : ""}`;

// Asked on the page, not with confirm(): some in-app browsers silently block pop-ups
const askDeactivate = (open) => {
  $("#deactivate").hidden = open;
  $("#deactivate-confirm").hidden = !open;
};
$("#deactivate").addEventListener("click", () => askDeactivate(true));
$("#deactivate-no").addEventListener("click", () => askDeactivate(false));
$("#deactivate-yes").addEventListener("click", async (e) => {
  e.target.disabled = true;
  const { error } = await sb.rpc("deactivate_my_account");
  if (error) {
    e.target.disabled = false;
    askDeactivate(false);
    return say($("#deactivate-msg"), error.message, "error");
  }
  await sb.auth.signOut({ scope: "local" });
  location.replace("index.html");
});

let state = null;          // latest my_game_state
let teams = [];            // every team row (run chips need inactive ones too)
let offset = 0;            // server time minus phone time, in ms
let picking = false;       // picker open?
let league = null;         // step 1 choice (normal weeks)
let selected = null;       // club tapped, waiting for Confirm
let saving = false;
let roundId = null;        // double header: which of the two open gameweeks is on screen
let running = null, again = null;   // refresh() in flight / queued
let teamsStale = false;    // re-load the teams list on the next fetch
let lastFetch = 0, refetchedFor = null;

const teamById = (id) => teams.find((t) => t.id === id);
const shortName = (id) => { const t = teamById(id); return t ? (t.short_name || t.name) : "?"; };

/* ---------- Formatting ---------- */

const ukFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short",
  hour: "numeric", minute: "2-digit", hour12: true,
});
// "Fri 7 Nov, 5:00pm" in UK time, whatever the phone's timezone
function fmtDeadline(iso) {
  const p = Object.fromEntries(ukFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}${p.dayPeriod.toLowerCase()}`;
}

// Days/hours/minutes, with seconds in the last hour
function fmtLeft(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// Colours come from the database, so only let plain hex values into a style attribute
const hex = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : fallback);
function swatch(t) {
  return `<span class="swatch" style="--c1:${hex(t.colour1, "#888888")};--c2:${hex(t.colour2, hex(t.colour1, "#888888"))}" aria-hidden="true"></span>`;
}

/* ---------- Loading ---------- */

async function load() {
  const reloadTeams = teamsStale;
  teamsStale = false;
  const asked = roundId;
  const [st, tm] = await Promise.all([
    sb.rpc("my_game_state", asked ? { p_gameweek_id: asked } : {}),
    teams.length && !reloadTeams ? { data: teams } : sb.from("teams").select("id,name,short_name,league,colour1,colour2,active"),
  ]);
  if (st.error || tm.error || !st.data) throw st.error || tm.error || new Error("No data");
  teams = tm.data;
  state = st.data;
  // Stay on the gameweek the server showed until the player switches (only matters with two open).
  // If they tapped the other one while this was loading, keep their choice for the next load.
  if (roundId === asked) roundId = openRounds().length > 1 && state.gameweek ? state.gameweek.id : null;
  offset = Date.parse(state.now) - Date.now();   // fixes a wrong phone clock
}

// One fetch at a time. A call made mid-fetch queues exactly one more, and waits for that one.
function refresh() {
  if (!running) {
    running = doRefresh().finally(() => { running = null; });
    return running;
  }
  again ??= running.then(() => { again = null; return refresh(); });
  return again;
}

async function doRefresh() {
  lastFetch = Date.now();   // set up front so a failed fetch doesn't retry every second
  const couldPick = state && state.can_pick;
  const wasGw = state && state.gameweek ? state.gameweek.id : null;
  try {
    await load();
    $("#error").textContent = "";
    $("#error").className = "msg error";
    // A different gameweek is on screen now: drop any half-made choice from the old one
    if (wasGw !== null && (state.gameweek ? state.gameweek.id : null) !== wasGw) {
      picking = false; selected = null; league = null;
    }
    if (couldPick && !state.can_pick && picking) {
      say($("#flash"), "Picks have just locked.", "");
    }
    if (!state.can_pick) { picking = false; selected = null; league = null; }
    else {
      if (selected && !pickable(selected)) selected = null;
      if (state.pick_team_id == null) picking = true;   // nothing chosen yet: open the picker
    }
    const rendered = render();
    $("#game").hidden = false;
    await rendered;
  } catch {
    say($("#error"), "Sorry, we couldn't load your game just now. Please check your connection and refresh the page.", "error");
  } finally {
    $("#loading").hidden = true;
  }
}

/* ---------- Rendering ---------- */

async function render() {
  renderRounds();
  renderStatus();
  renderBanner();
  renderCurrent();
  renderPicker();
  renderRun();
  await renderPay();
}

// Every open gameweek, each with this player's pick and deadline. Two means a double header.
const openRounds = () => (state && Array.isArray(state.rounds) ? state.rounds : []);

// Double header: a switch between the two open gameweeks, showing what is still to pick
function renderRounds() {
  const el = $("#rounds");
  const rounds = openRounds();
  el.hidden = !(rounds.length > 1 && state.entry_status === "alive" && state.gameweek);
  if (el.hidden) { el.innerHTML = ""; return; }
  const label = (r) => r.mode === "off" ? "Week off"
    : r.pick_team_id != null ? `${shortName(r.pick_team_id)} ✓`
    : r.can_pick ? "Pick needed" : "No pick";
  const todo = rounds.filter((r) => r.can_pick && r.pick_team_id == null).length;
  el.innerHTML = `
    <h2>Two gameweeks are open</h2>
    <p>You need a winning pick in <strong>both</strong> to stay in.${todo ? ` <strong>${todo} still to pick.</strong>` : ""}</p>
    <div class="chips" role="group" aria-label="Choose a gameweek">
      ${rounds.map((r) => `<button type="button" class="chip" data-round="${r.id}" aria-pressed="${r.id === state.gameweek.id}">GW${r.number}: ${escapeHtml(label(r))}</button>`).join("")}
    </div>
    <p class="muted small">${rounds.map((r) => r.mode === "off" ? `GW${r.number} is a week off`
      : `GW${r.number} locks ${escapeHtml(fmtDeadline(r.deadline))}`).join(" · ")}</p>`;
}

function renderStatus() {
  const { game, entry_status: es, gameweek: gw } = state;
  let pill = "", title, cls = "none";
  if (!game) title = "No game running at the moment";
  else if (!es) title = "You're not in this game";
  else if (es === "alive") { cls = "in"; pill = "IN"; title = "You're still in"; }
  else if (es === "out") { cls = "out"; pill = "OUT"; title = "You're out"; }
  else { cls = "winner"; pill = "WINNER"; title = "You won the game"; }

  const meta = [];
  if (game) meta.push(game.name);
  if (game && gw) meta.push(`Gameweek ${gw.number}`);

  // Deadline only matters while an alive player has an open, non-off week
  const showDeadline = es === "alive" && gw && gw.mode !== "off" && gw.status === "open";
  $("#status").className = `card status ${cls}`;
  $("#status").innerHTML = `
    <div class="status-top">
      ${pill ? `<span class="pill ${cls}">${pill}</span>` : ""}
      <h2>${escapeHtml(title)}</h2>
    </div>
    ${meta.length ? `<p class="muted status-meta">${meta.map(escapeHtml).join(" · ")}</p>` : ""}
    ${showDeadline ? `
      <p class="deadline">Picks lock ${escapeHtml(fmtDeadline(state.deadline))}</p>
      <p class="countdown" id="countdown"></p>` : ""}`;
  tick();
}

function renderBanner() {
  const el = $("#banner");
  el.hidden = !(state.reopened && state.can_pick && state.pick_team_id == null);
  if (!el.hidden) {
    el.textContent = `Your match was postponed – pick again by ${fmtDeadline(state.deadline)}`;
  }
}

function renderCurrent() {
  const el = $("#current");
  const { gameweek: gw, entry_status: es, pick_team_id: pid } = state;
  el.hidden = true;
  if (!gw || !es) return;

  if (gw.mode === "off") {
    el.hidden = false;
    el.innerHTML = `<h2>Your pick</h2><p class="week-off">Week off – no pick needed this week</p>`;
    return;
  }
  const t = pid != null ? teamById(pid) : null;
  if (!t) {
    if (es === "alive" && !state.can_pick) {
      el.hidden = false;
      el.innerHTML = `<h2>Your pick</h2><p>You haven't made a pick for this gameweek, and picks are locked.</p>`;
    }
    return;
  }
  const res = state.run.find((r) => r.number === gw.number);
  const result = res && res.result === "won" ? `<span class="badge won">Won</span>`
    : res && res.result === "lost" ? `<span class="badge lost">Lost</span>` : "";
  el.hidden = false;
  el.innerHTML = `
    <h2>Your pick for GW${gw.number}</h2>
    <div class="pick-big">${swatch(t)}<span class="pick-name">${escapeHtml(t.name)}</span></div>
    <div class="row">
      ${state.can_pick
        ? (picking ? "" : `<button type="button" class="go" id="change">Change pick</button>`)
        : `<span class="badge locked">Locked</span>`}
      ${result}
    </div>`;
}

// Teams the player can choose from this week
function pool() {
  const gw = state.gameweek;
  if (gw.mode === "custom") {
    const ok = new Set(state.allowed_team_ids || []);
    return teams.filter((t) => ok.has(t.id));
  }
  return teams.filter((t) => t.active && NORMAL_LEAGUES.includes(t.league));
}
const isUsed = (id) => state.used_team_ids.includes(id);
const pickable = (id) => state.can_pick && !isUsed(id) && pool().some((t) => t.id === id);

function tileHtml(t) {
  const usedGw = isUsed(t.id) ? state.run.find((r) => r.team_id === t.id && r.number !== state.gameweek.number) : null;
  const current = t.id === state.pick_team_id;
  const chosen = t.id === selected;
  const note = isUsed(t.id) ? (usedGw ? `Used GW${usedGw.number}` : "Used")
    : current ? "Current pick" : chosen ? "✓ Selected" : "";
  return `
    <button type="button" class="team${chosen ? " selected" : ""}${current ? " current" : ""}" data-id="${t.id}"
      aria-label="${escapeHtml(t.name + (note ? ", " + note.replace("✓ ", "") : ""))}" aria-pressed="${chosen}"${current ? ' aria-current="true"' : ""}${isUsed(t.id) || current ? " disabled" : ""}>
      ${swatch(t)}
      <span class="team-text">
        <span class="team-name">${escapeHtml(t.short_name || t.name)}</span>
        ${note ? `<span class="team-note">${note}</span>` : ""}
      </span>
    </button>`;
}

const gridHtml = (list) =>
  `<div class="teams">${list.slice().sort((a, b) => a.name.localeCompare(b.name)).map(tileHtml).join("")}</div>`;

function renderPicker(focus) {
  const el = $("#picker");
  const gw = state.gameweek;
  const open = state.can_pick && picking && gw;
  el.hidden = !open;
  if (!open) { el.innerHTML = ""; updateBar(); return; }

  const all = pool();
  let body;
  if (gw.mode === "custom") {
    // Special week: only the teams the host allowed, grouped by league
    body = `<h3>This week's teams</h3>` + (all.length ? LEAGUES
      .map(([code, name]) => [name, all.filter((t) => t.league === code)])
      .filter(([, list]) => list.length)
      .map(([name, list]) => `<h4>${name}</h4>${gridHtml(list)}`).join("")
      : `<p class="muted">The host hasn't listed this week's teams yet.</p>`);
  } else if (!league) {
    body = `<h3>Choose a league</h3><div class="leagues">` + LEAGUES
      .filter(([code]) => NORMAL_LEAGUES.includes(code))
      .map(([code, name]) => {
        const left = all.filter((t) => t.league === code && !isUsed(t.id)).length;
        return `<button type="button" class="league" data-league="${code}"${left ? "" : " disabled"}>
          <span class="league-name">${name}</span>
          <span class="muted small">${left} club${left === 1 ? "" : "s"} available</span></button>`;
      }).join("") + `</div>`;
  } else {
    body = `
      <div class="row between picker-nav">
        <button type="button" class="secondary" data-back>← All leagues</button>
        <h3>${LEAGUE_NAME[league]}</h3>
      </div>${gridHtml(all.filter((t) => t.league === league))}`;
  }

  el.innerHTML = `
    <h2 id="picker-title" tabindex="-1">Pick your team for GW${gw.number}</h2>
    <p class="muted small">You can only use each club once in this game.</p>
    ${body}
    ${state.pick_team_id != null ? `<p><button type="button" class="link" data-close>Keep my current pick</button></p>` : ""}`;
  if (focus) $(focus, el)?.focus();
  updateBar();
}

function renderRun() {
  const el = $("#run");
  el.hidden = !(state.entry_status && state.run.length);
  if (el.hidden) return;
  const cells = state.run.map((r) => {
    let cls, label, team = r.team_id != null ? escapeHtml(shortName(r.team_id)) : "–";
    if (r.mode === "off") { cls = "off"; label = "Off"; }
    else if (r.team_id == null && r.status === "resulted") { cls = "lost"; label = "No pick"; }
    else if (r.result === "won") { cls = "won"; label = "Won"; }
    else if (r.result === "lost") { cls = "lost"; label = "Lost"; }
    else { cls = "pending"; label = "Pending"; }
    return `<li class="cell ${cls}"><span class="cell-gw">GW ${r.number}</span>
      <span class="cell-team">${team}</span><span class="cell-res">${label}</span></li>`;
  });
  el.innerHTML = `<h2 id="run-title">My run</h2><ol class="run">${cells.join("")}</ol>`;
}

function updateBar() {
  const show = !!(picking && selected && state.can_pick);
  $("#bar").hidden = !show;
  document.body.classList.toggle("has-bar", show);
  if (show) $("#bar-text").textContent = `Pick ${teamById(selected).name}?`;
}

/* ---------- Countdown ---------- */

function tick() {
  const el = $("#countdown");
  if (!el || !state) return;
  const left = Date.parse(state.deadline) - (Date.now() + offset);
  if (left > 0) {
    el.innerHTML = `Time left: <strong>${fmtLeft(left)}</strong>`;
    return;
  }
  el.innerHTML = `<strong>Picks are locked</strong>`;
  // Re-fetch once at zero so the screen locks; keep trying while the server still says open
  const due = refetchedFor !== state.deadline;
  if (!running && (due || (state.can_pick && Date.now() - lastFetch > 15000))) {
    refetchedFor = state.deadline;
    refresh();
  }
}
setInterval(tick, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state) return;
  teamsStale = true;
  refresh();
});

/* ---------- Picker actions ---------- */

// Double header: show the other open gameweek
$("#rounds").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-round]");
  if (!b || saving) return;
  const id = Number(b.dataset.round);
  if (id === roundId) return;
  roundId = id;
  picking = false; selected = null; league = null;
  say($("#flash"), "");
  await refresh();
  $('#rounds [aria-pressed="true"]')?.focus();
});

$("#current").addEventListener("click", (e) => {
  if (!e.target.closest("#change")) return;
  picking = true; league = null; selected = null;
  say($("#flash"), "");
  renderCurrent();
  renderPicker("#picker-title");
});

$("#picker").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.league) {
    league = b.dataset.league; selected = null;
    renderPicker("[data-back]");
  } else if ("back" in b.dataset) {
    const was = league;
    league = null; selected = null;
    renderPicker(`[data-league="${was}"]`);
  } else if (b.dataset.id) {
    const id = Number(b.dataset.id);
    selected = selected === id ? null : id;
    say($("#bar-msg"), "");
    renderPicker(`[data-id="${id}"]`);
  } else if ("close" in b.dataset) {
    picking = false; selected = null; league = null;
    renderCurrent();
    renderPicker();
    $("#change")?.focus();
  }
});

$("#bar-cancel").addEventListener("click", () => {
  const id = selected;
  selected = null;
  say($("#bar-msg"), "");
  renderPicker(`[data-id="${id}"]`);
});

$("#bar-ok").addEventListener("click", async () => {
  if (!selected || saving) return;
  const t = teamById(selected);
  saving = true;
  $("#bar-ok").disabled = $("#bar-cancel").disabled = true;
  $("#bar-ok").textContent = "Saving…";
  let error = null;
  try {
    // Say which gameweek the pick is for (the one on screen), so it can't land in the other one
    const forGw = Array.isArray(state.rounds) && state.gameweek ? { p_gameweek_id: state.gameweek.id } : {};
    ({ error } = await sb.rpc("make_pick", { p_team_id: selected, ...forGw }));
  } catch {
    error = { message: "Couldn't save your pick. Please check your connection and try again." };
  }
  saving = false;
  $("#bar-ok").disabled = $("#bar-cancel").disabled = false;
  $("#bar-ok").textContent = "Confirm";
  if (error) {
    // Keep the selection so they can retry or choose another club
    const msg = error.message || "Couldn't save your pick. Please try again.";
    say($("#bar-msg"), msg, "error");
    teamsStale = true;
    await refresh();   // the week may have locked or changed
    if ($("#bar").hidden) say($("#flash"), msg, "error");   // bar is gone, so show it up top
    return;
  }
  picking = false; selected = null; league = null;
  say($("#bar-msg"), "");
  await refresh();
  // Double header: go straight on to the other gameweek if it still needs a pick
  const next = openRounds().find((r) => r.can_pick && r.pick_team_id == null && r.id !== roundId);
  if (next) {
    roundId = next.id;
    await refresh();
    say($("#flash"), `Pick saved: ${t.name}. Now make your pick for GW${next.number}.`, "ok");
  } else {
    say($("#flash"), `Pick saved: ${t.name}. Good luck!`, "ok");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* ---------- Payment details (shown when the player isn't in the active game) ---------- */

let payReady;   // promise: true if the host has set bank details
function setupPay() {
  payReady ??= (async () => {
    // Payment details: shown prominently while a player has no credit
    const { data: s, error } = await sb.from("app_settings").select("*").single();
    if (error) throw error;
    if (!(s && s.pay_account_number)) return false;
    const awaiting = me.credit === 0;
    $("#pay-title").innerHTML = awaiting
      ? 'Awaiting payment <span class="badge wait">0 credit</span>' : "Pay for more games";
    $("#pay-intro").textContent = awaiting
      ? "Pay the host by bank transfer. Once they've checked it, they'll add your credit and you'll be in the next game."
      : "To add more credit, pay the host by bank transfer using your reference.";
    const digits = (v) => v.replace(/\D/g, "");   // banking apps want plain numbers
    const rows = [
      ["Name", s.pay_account_name, s.pay_account_name],
      ["Sort code", s.pay_sort_code, digits(s.pay_sort_code)],
      ["Account", s.pay_account_number, digits(s.pay_account_number)],
      ["Reference", payRef(s.pay_ref_prefix, me), payRef(s.pay_ref_prefix, me)],
    ];
    $("#pay-details").innerHTML = rows.map(([label, shown, copied]) => `
      <dt>${label}</dt>
      <dd${label === "Reference" ? ' class="ref"' : ""}>${escapeHtml(shown)}</dd>
      <button type="button" class="copy" data-copy="${escapeHtml(copied)}" aria-label="Copy ${label}">Copy</button>`).join("");
    $("#pay-note").textContent = s.pay_note;

    $("#pay-details").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-copy]");
      if (!btn) return;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      } catch { btn.textContent = "Copy failed"; }
    });
    return true;
  })().catch(() => { payReady = undefined; return false; });   // don't cache a failure: retry next time
  return payReady;
}

async function renderPay() {
  const needed = !state.game || !state.entry_status;
  if (!needed) { $("#pay").hidden = true; return; }
  const ok = await setupPay();
  $("#pay").hidden = !(ok && (!state.game || !state.entry_status));
}

await refresh();
