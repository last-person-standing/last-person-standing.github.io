// Overview screen: survivors, most popular picks, and the picks grid. Everyone logged in can see it.
// What each player may see is decided by the server (overview_data); this page only draws it.
import { sb, $, say, escapeHtml as esc, requireUser } from "./app.js";

const me = await requireUser();
const root = $("#ov");
const loading = $("#loading");
const msg = $("#msg");

// Colours come from the database, so only let plain hex values into a style attribute
const hex = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : fallback);
const swatch = (t, extra = "") =>
  `<span class="swatch${extra}" style="--c1:${hex(t.colour1, "#888888")};--c2:${hex(t.colour2, hex(t.colour1, "#888888"))}" aria-hidden="true"></span>`;

const ukFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
const ukWhen = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? `${ukFmt.format(d)} (UK time)` : null;
};

const TOP_N = 10;
const MARK = { won: "✓", lost: "✗" };   // tick, cross
const SR_RESULT = { won: "won", lost: "lost", pending: "result not in yet" };

let teams = new Map();
let currentGameId = null;
let gameIds = [];                    // real ids, so a number stays a number when sent back to the server
let token = 0;                       // ignores slow replies after the player switches game
let state = { rows: [], filter: "all", q: "" };

async function load(gameId) {
  const mine = ++token;
  try {
    const [res, tm] = await Promise.all([
      sb.rpc("overview_data", { p_game_id: gameId }),
      teams.size ? null : sb.from("teams").select("id,name,short_name,colour1,colour2"),
    ]);
    if (mine !== token) return;
    // With no game yet the server sends just { game: null, games: [] }
    if (res.error || !res.data || (res.data.game && !Array.isArray(res.data.players))) {
      throw res.error || new Error("bad data");
    }
    if (tm) {
      if (tm.error) throw tm.error;
      teams = new Map((tm.data || []).map((t) => [t.id, t]));
    }
    say(msg, "");
    render(res.data);
    currentGameId = res.data.game ? res.data.game.id : null;
    gameIds = (res.data.games || []).map((g) => g.id);
  } catch (e) {
    if (mine !== token) return;
    console.error(e);
    say(msg, "Couldn't load the overview. Please refresh the page and try again.", "error");
    const sel = $("#game-select");
    if (sel && currentGameId != null) sel.value = String(currentGameId);
  } finally {
    if (mine === token) {
      loading.hidden = true;
      if (root.innerHTML) root.hidden = false;
    }
  }
}

function render(d) {
  const { game } = d;
  if (!game) {
    root.innerHTML = `<h1>Overview</h1><section class="card"><p class="big-line"><strong>No game has started yet</strong></p>
      <p class="muted">Nothing to show here until the host starts a game.</p></section>`;
    return;
  }

  const gws = [...d.gameweeks].sort((a, b) => a.number - b.number);
  const players = [...d.players];
  const alive = (p) => p.status !== "out";
  const total = players.length;
  const stillIn = players.filter(alive).length;
  const curGw = gws[gws.length - 1] || null;
  const finished = game.status === "finished";

  root.innerHTML = headerCard(d, game, players, finished) +
    survivorsCard(stillIn, total, curGw, finished) +
    picksCard(d, gws, curGw, finished) +
    gridCard(d, gws, players, stillIn, total);

  state = { rows: buildRows(d, gws, players), filter: "all", q: "" };
  applyFilter();
  const wrap = $("#grid-wrap");
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;   // newest weeks matter most; names stay pinned
}

/* ---- header ---- */
function headerCard(d, game, players, finished) {
  const select = d.games.length > 1
    ? `<label class="ov-switch">Viewing game
        <select id="game-select">${d.games.map((g) =>
          `<option value="${esc(g.id)}"${g.id === game.id ? " selected" : ""}>${esc(g.name)}${g.status === "finished" ? " (finished)" : ""}</option>`).join("")}
        </select></label>`
    : "";
  let winner = "";
  if (finished) {
    const names = players.filter((p) => p.status === "winner").map((p) => esc(p.name));
    winner = `<div class="banner ov-winner">
      <strong>${names.length > 1 ? "Winners" : "Winner"}: ${names.length ? names.join(", ") : "none"}</strong>
      ${game.winner_note ? `<p>${esc(game.winner_note)}</p>` : ""}</div>`;
  }
  return `<header class="ov-head">
      <h1>${esc(game.name)}</h1>
      <span class="badge ${finished ? "" : "won"}">${finished ? "Finished" : "In progress"}</span>
    </header>${select}${winner}`;
}

/* ---- survivors ---- */
function survivorsCard(stillIn, total, curGw, finished) {
  const pct = total ? Math.round((stillIn / total) * 100) : 0;
  const week = !curGw ? "No gameweeks yet"
    : finished ? `Finished in gameweek ${curGw.number}` : `Gameweek ${curGw.number}`;
  return `<section class="card" aria-labelledby="sv-h">
    <h2 id="sv-h" class="sr">Survivors</h2>
    <p class="ov-big"><strong>${stillIn}</strong> of ${total} still in</p>
    <div class="meter" role="progressbar" aria-label="Players still in" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${stillIn}"><span style="width:${pct}%"></span></div>
    <p class="muted small ov-week">${esc(week)}${total ? ` · ${pct}% still in` : ""}</p>
  </section>`;
}

/* ---- most popular picks ---- */
function picksCard(d, gws, curGw, finished) {
  const chartGw = [...gws].reverse().find((g) => g.revealed && g.mode !== "off") || null;
  const hidden = curGw && !finished && !curGw.revealed && curGw.mode !== "off";
  const when = hidden ? ukWhen(curGw.deadline) : null;
  const notice = hidden
    ? `<p class="banner ov-hidden"><span aria-hidden="true">🔒 </span>This week's picks are hidden until ${when ? esc(when) : "the deadline"}.</p>`
    : "";

  let body = `<p class="muted">No picks have been revealed yet.</p>`;
  let title = "This week's picks";
  if (chartGw) {
    title = chartGw === curGw && !finished ? "This week's picks" : `Gameweek ${chartGw.number} picks`;
    const counts = new Map();
    let n = 0;
    for (const p of d.picks) {
      if (p.gameweek !== chartGw.number || p.team_id == null) continue;
      const c = counts.get(p.team_id) || { id: p.team_id, n: 0, won: 0, lost: 0 };
      c.n++; n++;
      if (p.result === "won") c.won++; else if (p.result === "lost") c.lost++;
      counts.set(p.team_id, c);
    }
    const label = (c) => (teams.get(c.id) || {}).short_name || "";
    const sorted = [...counts.values()].sort((a, b) => b.n - a.n || label(a).localeCompare(label(b), "en-GB"));
    const top = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    const otherN = rest.reduce((s, c) => s + c.n, 0);
    const max = top.length ? top[0].n : 1;
    const pctOf = (v) => `${Math.round((v / n) * 100)}%`;
    const row = (swatchHtml, nameHtml, count, res) => `<li class="bar-row">
        <div class="bar-top">${swatchHtml}<span class="bar-name">${nameHtml}</span>
          <span class="bar-val"><strong>${count}</strong> · ${pctOf(count)}</span></div>
        <div class="bar-track" aria-hidden="true"><span class="bar-fill ${res}" style="width:${Math.max(2, Math.round((count / max) * 100))}%"></span></div>
      </li>`;

    if (!n) {
      body = `<p class="muted">Nobody made a pick in this week.</p>`;
    } else {
      const rows = top.map((c) => {
        const t = teams.get(c.id) || { name: "Unknown team", short_name: "?" };
        const res = c.lost ? "lost" : c.won ? "won" : "pending";
        const mark = MARK[res] ? ` <span class="bar-res" aria-hidden="true">${MARK[res]}</span>` : "";
        return row(swatch(t), `<span aria-hidden="true">${esc(t.short_name)}</span><span class="sr">${esc(t.name)}, ${SR_RESULT[res]}</span>${mark}`, c.n, res);
      });
      if (rest.length) {
        rows.push(row(`<span class="swatch other" aria-hidden="true"></span>`,
          `Others (${rest.length} ${rest.length === 1 ? "team" : "teams"})`, otherN, "other"));
      }
      body = `<p class="muted small">Gameweek ${chartGw.number} · ${n} ${n === 1 ? "pick" : "picks"}</p>
        <ol class="bars">${rows.join("")}</ol>
        <ul class="legend" aria-label="Key">
          <li><span class="lg-box won" aria-hidden="true"></span>${MARK.won} Won</li>
          <li><span class="lg-box lost" aria-hidden="true"></span>${MARK.lost} Lost</li>
          <li><span class="lg-box pending" aria-hidden="true"></span>Result not in yet</li>
        </ul>`;
    }
  }
  return `<section class="card" aria-labelledby="pk-h"><h2 id="pk-h">${esc(title)}</h2>${notice}${body}</section>`;
}

/* ---- the grid ---- */
function gridCard(d, gws, players, stillIn, total) {
  const head = gws.map((g) =>
    `<th scope="col" class="gwh${g.mode === "off" ? " off" : ""}">GW${g.number}${g.mode === "off" ? `<span class="sr"> (week off)</span>` : ""}</th>`).join("");
  return `<section class="card ov-grid-card" aria-labelledby="gr-h">
    <div class="ov-pad">
      <h2 id="gr-h">Everyone's picks</h2>
      <label class="ov-search">Find a player<input id="q" type="search" autocomplete="off" placeholder="Search by name"></label>
      <div class="chips" role="group" aria-label="Show players">
        <button type="button" class="chip" data-f="all" aria-pressed="true">All (${total})</button>
        <button type="button" class="chip" data-f="in" aria-pressed="false">Still in (${stillIn})</button>
        <button type="button" class="chip" data-f="out" aria-pressed="false">Out (${total - stillIn})</button>
      </div>
      <p id="count" class="muted small" aria-live="polite"></p>
    </div>
    <div id="grid-wrap" class="grid-wrap" tabindex="0" role="region" aria-label="Picks grid, scrolls sideways">
      <table class="ov-grid">
        <caption class="sr">Each player's pick in each gameweek. Scroll sideways to see more gameweeks.</caption>
        <thead><tr><th scope="col" class="corner">Player</th>${head}</tr></thead>
        <tbody id="grid-body"></tbody>
      </table>
    </div>
    <p id="grid-empty" class="muted ov-pad" hidden>No players match.</p>
    <ul class="legend ov-pad" aria-label="Key">
      <li><span class="lg-box won" aria-hidden="true"></span>${MARK.won} Won</li>
      <li><span class="lg-box lost" aria-hidden="true"></span>${MARK.lost} Lost</li>
      <li><span class="lg-box pending" aria-hidden="true"></span>Result not in yet</li>
      <li><span class="lg-box hid" aria-hidden="true"></span>? Hidden until the deadline</li>
    </ul>
  </section>`;
}

function buildRows(d, gws, players) {
  const picks = new Map();
  for (const p of d.picks) picks.set(`${p.player_id}|${p.gameweek}`, p);

  const rank = (p) => (p.status === "winner" ? 0 : p.status === "alive" ? 1 : 2);
  const sorted = [...players].sort((a, b) =>
    rank(a) - rank(b) ||
    (rank(a) === 2 ? (b.out_gameweek ?? 0) - (a.out_gameweek ?? 0) : 0) ||
    String(a.name).localeCompare(String(b.name), "en-GB", { sensitivity: "base" }));

  return sorted.map((p) => {
    const isOut = p.status === "out";
    const outGw = isOut && p.out_gameweek != null ? p.out_gameweek : Infinity;
    const mine = me && p.id === me.id;
    const cells = gws.map((g) => {
      if (g.number > outGw) return `<td class="g gone"></td>`;
      if (g.mode === "off") return `<td class="g off">Off</td>`;
      if (!g.revealed) return `<td class="g hid">?<span class="sr">Hidden until the deadline</span></td>`;
      const pk = picks.get(`${p.id}|${g.number}`);
      if (!pk || pk.team_id == null) {
        const bad = (pk && pk.result === "lost") || g.status === "resulted";
        return `<td class="g ${bad ? "nopick" : "pending"}">${bad ? `<span aria-hidden="true">${MARK.lost} </span>` : ""}No pick</td>`;
      }
      const t = teams.get(pk.team_id);
      const res = pk.result === "won" || pk.result === "lost" ? pk.result : "pending";
      return `<td class="g ${res}">${MARK[res] ? `<span aria-hidden="true">${MARK[res]} </span>` : ""}${esc(t ? t.short_name : "Unknown")}<span class="sr">, ${SR_RESULT[res]}</span></td>`;
    }).join("");
    const tag = mine ? `<span class="pl-tag">You</span>` : "";
    const sub = isOut ? `<span class="pl-sub">Out${p.out_gameweek != null ? ` GW${p.out_gameweek}` : ""}</span>`
      : p.status === "winner" ? `<span class="pl-sub win">Winner</span>` : "";
    return {
      alive: !isOut,
      lc: String(p.name).toLowerCase(),
      html: `<tr class="${isOut ? "is-out" : ""}${mine ? " me" : ""}"><th scope="row" class="pl"><span class="pl-name">${esc(p.name)}</span>${tag}${sub}</th>${cells}</tr>`,
    };
  });
}

function applyFilter() {
  const q = state.q.trim().toLowerCase();
  const list = state.rows.filter((r) =>
    (state.filter === "all" || (state.filter === "in") === r.alive) && (!q || r.lc.includes(q)));
  $("#grid-body").innerHTML = list.map((r) => r.html).join("");
  $("#grid-empty").hidden = list.length > 0;
  $("#count").textContent = `Showing ${list.length} of ${state.rows.length} players`;
}

// One listener each, for the whole page
root.addEventListener("input", (e) => {
  if (e.target.id === "q") { state.q = e.target.value; applyFilter(); }
});
root.addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f;
  root.querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  applyFilter();
});
root.addEventListener("change", async (e) => {
  if (e.target.id !== "game-select") return;
  await load(gameIds.find((id) => String(id) === e.target.value) ?? null);
  const sel = $("#game-select");
  if (sel) sel.focus();
});

await load(null);
