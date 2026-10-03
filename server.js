// GDSA Ranked - minimal matchmaking server (no dependencies).
// NOTE: data is stored in data.json; free hosts may wipe it on restart.
const http = require("http");
const fs = require("fs");
const DATA_FILE = "data.json";
const PORT = process.env.PORT || 3000;

let db = { players: {}, sync: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
const save = () => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {});

const queue = new Map();   // accountId -> { mmr, since, seen }
const found = new Map();   // accountId -> match (pending notification)
const matches = new Map(); // matchId -> match
let nextId = 1;

function elo(me, opp, won) {
  const exp = 1 / (1 + Math.pow(10, (opp - me) / 400));
  return Math.round(32 * ((won ? 1 : 0) - exp));
}
function player(id, body = {}) {
  const p = db.players[id] || (db.players[id] = { name: "Player" + id, mmr: 0, wins: 0, losses: 0, streak: 0, platform: "?", region: "ID" });
  if (body.name) p.name = String(body.name).slice(0, 20);
  if (body.platform) p.platform = String(body.platform).slice(0, 10);
  if (body.region) p.region = String(body.region).slice(0, 4);
  return p;
}
// window widens the longer a player waits: 150 MMR, +25 per 10s, max 600
const windowFor = (e) => Math.min(600, 150 + 25 * Math.floor((Date.now() - e.since) / 10000));

function tryMatch(id) {
  const me = queue.get(id);
  for (const [oid, other] of queue) {
    if (oid === id) continue;
    const diff = Math.abs(other.mmr - me.mmr);
    if (diff <= Math.max(windowFor(me), windowFor(other)) ) {
      queue.delete(id); queue.delete(oid);
      const m = { id: nextId++, a: id, b: oid, accept: {}, result: {}, done: false, t: Date.now() };
      matches.set(m.id, m); found.set(id, m); found.set(oid, m);
      return m;
    }
  }
  return null;
}
const view = (m, me) => {
  const oid = m.a === me ? m.b : m.a;
  const o = player(oid);
  return { status: "found", match_id: m.id, opponent: o.name, mmr: o.mmr, opponent_id: oid };
};

const routes = {
  "POST /match/find": (b) => {
    const id = String(b.account_id || ""); if (!id) return [400, { error: "account_id" }];
    const p = player(id, b); if (Number.isFinite(b.mmr)) p.mmr = Math.max(p.mmr, 0);
    if (found.has(id)) { const m = found.get(id); found.delete(id); return [200, view(m, id)]; }
    if (!queue.has(id)) queue.set(id, { mmr: p.mmr, since: Date.now(), seen: Date.now() });
    queue.get(id).seen = Date.now();
    const m = tryMatch(id);
    if (m) { found.delete(id); return [200, view(m, id)]; }
    return [200, { status: "waiting", queue: queue.size }];
  },
  "POST /match/cancel": (b) => { queue.delete(String(b.account_id)); return [200, { ok: true }]; },
  "POST /match/respond": (b) => {
    const m = matches.get(Number(b.match_id)); const id = String(b.account_id);
    if (!m || (m.a !== id && m.b !== id)) return [404, { error: "no match" }];
    m.accept[id] = !!b.accept;
    if (m.accept[m.a] === false || m.accept[m.b] === false) return [200, { status: "declined" }];
    return [200, { status: m.accept[m.a] && m.accept[m.b] ? "ready" : "waiting_opponent" }];
  },
  "POST /match/result": (b) => {
    const m = matches.get(Number(b.match_id)); const id = String(b.account_id);
    if (!m || m.done || (m.a !== id && m.b !== id)) return [404, { error: "no match" }];
    m.result[id] = !!b.won;
    if (m.result[m.a] === undefined || m.result[m.b] === undefined) return [200, { status: "waiting_opponent_report" }];
    if (m.result[m.a] === m.result[m.b]) { m.done = true; return [200, { status: "disputed" }]; } // both claim same outcome
    const pa = player(m.a), pb = player(m.b), aWon = m.result[m.a];
    const da = elo(pa.mmr, pb.mmr, aWon), db_ = elo(pb.mmr, pa.mmr, !aWon);
    for (const [p, d, w] of [[pa, da, aWon], [pb, db_, !aWon]]) {
      p.mmr = Math.max(0, p.mmr + d); p.streak = w ? p.streak + 1 : 0; w ? p.wins++ : p.losses++;
    }
    m.done = true; save();
    const mine = id === m.a ? da : db_;
    return [200, { status: "done", delta: mine, mmr: player(id).mmr, streak: player(id).streak }];
  },
  "GET /leaderboard": (b, q) => {
    const region = q.get("region");
    const list = Object.entries(db.players)
      .filter(([, p]) => !region || region === "WW" || p.region === region)
      .sort((x, y) => y[1].mmr - x[1].mmr).slice(0, 50)
      .map(([id, p]) => ({ id, name: p.name, mmr: p.mmr, platform: p.platform,
        winrate: p.wins + p.losses ? Math.round(100 * p.wins / (p.wins + p.losses)) : 0, blacklisted: !!p.banned }));
    return [200, { players: list }];
  },
  "POST /sync": (b) => { if (!b.key) return [400, { error: "key" }]; db.sync[b.key] = { mmr: b.mmr, streak: b.streak, t: Date.now() }; save(); return [200, { ok: true }]; },
  "GET /sync": (b, q) => { const s = db.sync[q.get("key")]; return s ? [200, s] : [404, { error: "not found" }]; },
  "GET /health": () => [200, { ok: true, queue: queue.size }],
};

setInterval(() => { // drop players who stopped polling
  for (const [id, e] of queue) if (Date.now() - e.seen > 20000) queue.delete(id);
}, 5000);

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const route = routes[`${req.method} ${url.pathname.replace(/^\/v1/, "")}`];
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on("end", () => {
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: "bad json" }); }
    if (!route) return send(res, 404, { error: "not found" });
    try { const [code, out] = route(body, url.searchParams); send(res, code, out); }
    catch (e) { send(res, 500, { error: "server" }); }
  });
}).listen(PORT, () => console.log("GDSA server on " + PORT));
function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
