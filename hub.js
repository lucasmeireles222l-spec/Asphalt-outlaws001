/* ASPHALT OUTLAWS — núcleo do servidor multiplayer (hub.js)
 * Lógica de salas, lobby, corrida sincronizada (10 Hz), amigos, convites e recompensas.
 * Independente de plataforma: roda dentro de um Durable Object da Cloudflare (worker.js)
 * e também em Node (extras/dev-server.mjs) para testes. Nenhuma chave secreta fica no HTML:
 * SUPABASE_SERVICE_KEY vive só como "secret" do Worker.
 * O servidor valida: limites 2..8, permissões, senha, distância da pista, progresso plausível,
 * ordem de chegada e recompensas (uma retirada por corrida). */
import TRACKS from './tracks.js';

export function createHub(env, opts) {
env = env || {}; opts = opts || {};
const ENV = env;
const SB_URL = (ENV.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = ENV.SUPABASE_ANON_KEY || '';
const SB_SERVICE = ENV.SUPABASE_SERVICE_KEY || ''; /* SECRETA */
const DEV = ENV.ALLOW_DEV_AUTH === '1';             /* só para testes locais */
const HAVE_SB = !!(SB_URL && SB_ANON && SB_SERVICE);
const log = (...a) => (opts.log || console.log)(...a);
if (!HAVE_SB && !DEV) console.error('Hub sem Supabase: defina SUPABASE_URL, SUPABASE_ANON_KEY e o secret SUPABASE_SERVICE_KEY.');

const MINP = 2, MAXP = 8, MAXSPEC = 12;
const TICK = 100, LEAD = 5000;              /* ms: snapshots / aviso antes da largada */
const MAXV = 170;                           /* m/s (612 km/h): teto físico generoso */
const GRACE_LOBBY = +ENV.GRACE_LOBBY_MS || 10000, GRACE_RACE = +ENV.GRACE_RACE_MS || 20000; /* tolerância p/ reconexão */
const FIN_TIMEOUT = 45000, RACE_MAX = 20 * 60000, STALE = 45000;
const BASE_PRIZE = [6000, 4000, 2500, 1500, 1000, 800, 600, 400], BASE_XP = [250, 170, 120, 80, 60, 50, 40, 30];
const REWARD_PER_HOUR = 10;
const TYPES = ['normal', 'sem_nitro'];
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rhex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };
const rint = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };

/* ============================ BANCO (Supabase REST ou memória) ============================ */
async function sbf(path, o = {}) {
  const r = await fetch(SB_URL + path, {
    method: o.method || 'GET',
    /* chaves novas (sb_secret_...) não são JWT: só vão no cabeçalho apikey; a service_role legada (JWT) também vai em Authorization */
    headers: Object.assign({ apikey: SB_SERVICE, 'Content-Type': 'application/json' }, SB_SERVICE.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + SB_SERVICE }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}
const pgList = a => '(' + a.join(',') + ')';

const sbDb = {
  async upsertPlayer(id, name) { await sbf('/rest/v1/mp_players?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: { user_id: id, username: name, username_lc: name.toLowerCase(), last_seen: new Date().toISOString() } }); },
  async findByName(name) {
    const lc = name.toLowerCase();
    let r = await sbf('/rest/v1/mp_players?username_lc=eq.' + encodeURIComponent(lc) + '&select=user_id,username&limit=1');
    if (r && r[0]) return { id: r[0].user_id, name: r[0].username };
    try { r = await sbf('/rest/v1/rpc/mp_lookup_user', { method: 'POST', body: { p_username: lc } }); if (r && r[0]) return { id: r[0].user_id, name: r[0].username }; } catch (e) { }
    return null;
  },
  async names(ids) { if (!ids.length) return {}; const r = await sbf('/rest/v1/mp_players?user_id=in.' + pgList(ids) + '&select=user_id,username'); const o = {}; (r || []).forEach(x => o[x.user_id] = x.username); return o; },
  async friendRows(id) { return await sbf('/rest/v1/mp_friends?or=(a.eq.' + id + ',b.eq.' + id + ')&select=a,b,status') || []; },
  async insertFriend(a, b) { await sbf('/rest/v1/mp_friends?on_conflict=a,b', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: { a, b, status: 'pending' } }); },
  async acceptFriend(a, b) { await sbf('/rest/v1/mp_friends?a=eq.' + a + '&b=eq.' + b, { method: 'PATCH', body: { status: 'accepted' } }); },
  async deleteFriend(x, y) { await sbf('/rest/v1/mp_friends?or=(and(a.eq.' + x + ',b.eq.' + y + '),and(a.eq.' + y + ',b.eq.' + x + '))', { method: 'DELETE' }); },
  async saveMatch(m) { await sbf('/rest/v1/mp_matches', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: m }); },
  async saveRewards(rows) { if (rows.length) await sbf('/rest/v1/mp_rewards', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: rows }); },
  async claim(uid, mid) { const r = await sbf('/rest/v1/mp_rewards?match_id=eq.' + encodeURIComponent(mid) + '&user_id=eq.' + uid + '&claimed_at=is.null', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { claimed_at: new Date().toISOString() } }); return r && r[0] ? { money: r[0].money, xp: r[0].xp, match: mid } : null; },
  async pending(uid) { const since = new Date(Date.now() - 86400000).toISOString(); const r = await sbf('/rest/v1/mp_rewards?user_id=eq.' + uid + '&claimed_at=is.null&created_at=gte.' + since + '&select=match_id,money,xp'); return (r || []).map(x => ({ match: x.match_id, money: x.money, xp: x.xp })); }
};

const memDb = (() => {
  const players = new Map(), friends = [], rewards = [], matches = [];
  return {
    async upsertPlayer(id, name) { players.set(id, name); },
    async findByName(name) { for (const [id, n] of players) if (n.toLowerCase() === name.toLowerCase()) return { id, name: n }; return null; },
    async names(ids) { const o = {}; ids.forEach(i => o[i] = players.get(i)); return o; },
    async friendRows(id) { return friends.filter(f => f.a === id || f.b === id).map(f => ({ ...f })); },
    async insertFriend(a, b) { if (!friends.find(f => f.a === a && f.b === b)) friends.push({ a, b, status: 'pending' }); },
    async acceptFriend(a, b) { const f = friends.find(f => f.a === a && f.b === b); if (f) f.status = 'accepted'; },
    async deleteFriend(x, y) { for (let i = friends.length - 1; i >= 0; i--) { const f = friends[i]; if ((f.a === x && f.b === y) || (f.a === y && f.b === x)) friends.splice(i, 1); } },
    async saveMatch(m) { matches.push(m); },
    async saveRewards(rows) { rows.forEach(r => { if (!rewards.find(q => q.match_id === r.match_id && q.user_id === r.user_id)) rewards.push({ ...r, claimed_at: null }); }); },
    async claim(uid, mid) { const r = rewards.find(q => q.match_id === mid && q.user_id === uid && !q.claimed_at); if (!r) return null; r.claimed_at = Date.now(); return { money: r.money, xp: r.xp, match: mid }; },
    async pending(uid) { return rewards.filter(q => q.user_id === uid && !q.claimed_at).map(q => ({ match: q.match_id, money: q.money, xp: q.xp })); }
  };
})();
const db = HAVE_SB ? sbDb : memDb;

/* ============================ AUTENTICAÇÃO ============================ */
const profCache = new Map();
async function authenticate(token, devName) {
  if (HAVE_SB && token && !String(token).startsWith('dev:')) {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('token_invalid');
    const u = await r.json();
    const c = profCache.get(u.id);
    if (c && Date.now() - c.at < 60000) return c.v;
    const pr = await fetch(SB_URL + '/rest/v1/rpc/load_profile', { method: 'POST', headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
    if (!pr.ok) throw new Error('profile_failed');
    const pf = await pr.json();
    const name = String(pf.username || (u.user_metadata && u.user_metadata.username) || '').slice(0, 20);
    if (!name) throw new Error('profile_failed');
    const own = new Set(((pf.save && pf.save.own) || []).map(Number));
    const v = { id: u.id, name, own, exCars: new Set(pf.cars || []), checkCars: true };
    profCache.set(u.id, { at: Date.now(), v });
    return v;
  }
  if (DEV && String(token).startsWith('dev:')) {
    const name = String(token).slice(4).replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
    if (name.length < 3) throw new Error('token_invalid');
    return { id: 'dev-' + name.toLowerCase(), name, own: null, exCars: null, checkCars: false };
  }
  throw new Error('token_invalid');
}
const clampI = (v, a, b, d) => { v = Math.floor(+v); return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
function cleanCar(c, who) {
  c = c || {};
  const ex = typeof c.ex === 'string' && /^[a-z0-9_]{2,24}$/i.test(c.ex) ? c.ex : null;
  const i = clampI(c.i, 0, 9999, 0);
  if (who.checkCars) { if (ex ? !who.exCars.has(ex) : !who.own.has(i)) return null; }
  const o = { i, ex, n: String(c.n || 'Carro').replace(/[<>\u0000-\u001f]/g, '').slice(0, 40), c: /^#[0-9a-f]{6}$/i.test(c.c) ? c.c : '#e01e2b' };
  ['r', 's', 'f', 'k', 'nn', 'sk', 'ho', 'xe', 'dc', 'ht'].forEach(k => { o[k] = clampI(c[k], 0, 30, 0); });
  return o;
}
const cleanName = (s, mn, mx) => { s = String(s == null ? '' : s).replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, mx); return s.length >= mn ? s : null; };

/* ============================ ESTADO ============================ */
const users = new Map();  /* userId -> player */
const rooms = new Map();  /* code -> room */
const tomb = new Map();   /* code -> ts (salas encerradas) */
const rewardLog = new Map();
async function hashPass(p, salt) {
  const enc = new TextEncoder(), key = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 20000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const send = (p, o) => { const w = p.ws; if (w && w.readyState === 1 && (w.bufferedAmount || 0) < 262144) { try { w.send(JSON.stringify(o)); } catch (e) { } } };
const sendRaw = (p, s) => { const w = p.ws; if (w && w.readyState === 1 && (w.bufferedAmount || 0) < 262144) { try { w.send(s); } catch (e) { } } };
const err = (p, code, msg) => send(p, { t: 'err', code, msg });
const newCode = () => { for (let n = 0; n < 200; n++) { let c = ''; for (let i = 0; i < 6; i++) c += CODE_CH[rint(CODE_CH.length)]; if (!rooms.has(c) && !tomb.has(c)) return c; } return null; };
const racers = r => r.players.filter(p => !p.spec);
const isConn = p => !p.disc;
const trackOf = id => TRACKS[id - 1];

function status(p) { const r = p.room; if (!r) return 'online'; return (r.state === 'starting' || r.state === 'racing') ? 'racing' : 'lobby'; }
function roomPub(r, full) {
  const o = { code: r.code, name: r.name, pass: !!r.pass, pub: r.pub, auto: r.auto, state: r.state, n: racers(r).length, max: MAXP, min: MINP, spec: r.cfg.spec, cfg: r.cfg, host: r.host };
  if (full) o.players = r.players.map(p => ({ id: p.slotId, name: p.name, car: p.car, ready: p.ready || p.id === r.host, host: p.id === r.host, spec: p.spec, ping: p.ping | 0, disc: !!p.disc }));
  return o;
}
const roomMsg = r => ({ t: 'room', r: roomPub(r, true) });
function bcast(r, o) { const s = JSON.stringify(o); r.players.forEach(p => sendRaw(p, s)); }
function pushRoom(r) { bcast(r, roomMsg(r)); }

/* ---- presença e amigos ---- */
async function loadFriends(p) {
  const rows = await db.friendRows(p.id), ids = new Set();
  rows.forEach(f => { ids.add(f.a); ids.add(f.b); }); ids.delete(p.id);
  const nm = await db.names([...ids]);
  p.friends = new Map(); p.reqIn = []; p.reqOut = [];
  rows.forEach(f => {
    const other = f.a === p.id ? f.b : f.a, name = nm[other] || '?';
    if (f.status === 'accepted') p.friends.set(other, name);
    else if (f.b === p.id) p.reqIn.push({ id: other, name }); else p.reqOut.push({ id: other, name });
  });
}
function friendList(p) {
  return [...p.friends].map(([id, name]) => { const q = users.get(id); const on = !!(q && q.ws); return { name, on, st: on ? status(q) : 'off', rc: on && q.room && q.room.state === 'lobby' ? q.room.code : null, lock: on && q.room ? !!q.room.pass : false }; });
}
const sendFriends = p => send(p, { t: 'friends', list: friendList(p), req: p.reqIn.map(x => x.name), inv: p.invites.filter(i => Date.now() - i.at < 120000).map(i => ({ from: i.from, code: i.code, room: i.room })) });
function presence(p) { if (!p.friends) return; p.friends.forEach((_, id) => { const q = users.get(id); if (q && q.ws) sendFriends(q); }); }

/* ============================ SALAS ============================ */
function cleanCfg(c, base) {
  c = c || {}; const o = Object.assign({ mapa: 0, track: 1, laps: 1, type: 'normal', spec: false }, base || {});
  const t = clampI(c.track, 1, TRACKS.length, o.track); o.track = t; o.mapa = trackOf(t).env;
  o.laps = clampI(c.laps, 1, 3, o.laps);
  o.type = TYPES.includes(c.type) ? c.type : o.type;
  if (c.spec !== undefined) o.spec = !!c.spec;
  return o;
}
async function createRoom(host, o) {
  const code = newCode(); if (!code) return null;
  const r = { code, name: o.name, host: host.id, pass: null, salt: null, pub: !!o.pub, auto: !!o.auto, cfg: o.cfg, players: [], state: 'lobby', created: Date.now(), invited: new Set(), seq: 0, nextSlot: 0, autoAt: 0 };
  if (o.pass) { r.salt = rhex(8); r.pass = await hashPass(o.pass, r.salt); }
  rooms.set(code, r); return r;
}
function addPlayer(r, p, spec) {
  p.room = r; p.spec = !!spec; p.ready = !!r.auto; p.slotId = r.nextSlot++; p.prog = 0; p.srv = 0; p.x = 0; p.spd = 0; p.rot = 0; p.fl = 0; p.lastP = 0; p.fin = 0; p.finAt = 0;
  r.players.push(p);
}
function dropRoom(r, why) { rooms.delete(r.code); tomb.set(r.code, Date.now()); clearTimeout(r.startT); clearTimeout(r.resetT); r.players.forEach(q => { q.room = null; if (q.disc) users.delete(q.id); else send(q, { t: 'left', why: 'closed' }); }); r.players = []; log('sala fechada', r.code, why || ''); }
function removePlayer(r, p, why) {
  const i = r.players.indexOf(p); if (i < 0) return;
  r.players.splice(i, 1); p.room = null; p.ready = false;
  if (r.state === 'racing' || r.state === 'starting') { const rec = r.racers && r.racers.find(x => x.p === p); if (rec) { rec.left = true; rec.why = why || 'saiu'; rec.prog = p.srv; } }
  if (!r.players.some(q => !q.spec) && !r.players.length) { dropRoom(r, 'vazia'); return; }
  if (r.host === p.id) { const nh = r.players.find(q => !q.spec && isConn(q)) || r.players.find(q => !q.spec); if (nh) r.host = nh.id; else { dropRoom(r, 'sem pilotos'); return; } }
  if (r.state === 'starting' && racers(r).filter(isConn).length < MINP) { r.state = 'lobby'; clearTimeout(r.startT); bcast(r, { t: 'cancel', msg: 'Largada cancelada: jogadores insuficientes.' }); }
  pushRoom(r); checkAuto(r);
}
function checkAuto(r) {
  if (!r.auto || r.state !== 'lobby') return;
  const n = racers(r).filter(isConn).length;
  if (n >= MINP && !r.autoAt) r.autoAt = Date.now() + 12000;
  if (n < MINP) r.autoAt = 0;
  if (n >= MAXP) r.autoAt = Math.min(r.autoAt || Infinity, Date.now() + 3000);
}
async function joinRoom(p, r, pass, spec) {
  if (p.room) return err(p, 'in_room', 'Você já está em uma sala.');
  if (r.pass && !r.invited.has(p.id) && r.host !== p.id) {
    if (p.failT && p.failT.filter(t => Date.now() - t < 60000).length >= 5) return err(p, 'throttle', 'Muitas tentativas. Aguarde um minuto.');
    const okp = pass && (await hashPass(String(pass).slice(0, 32), r.salt)) === r.pass;
    if (!okp) { (p.failT = p.failT || []).push(Date.now()); return err(p, 'bad_pass', 'Senha incorreta.'); }
  }
  /* checagens de vaga logo antes de entrar (sem await no meio): o 9º jogador nunca passa */
  if (p.room) return err(p, 'in_room', 'Você já está em uma sala.');
  if (rooms.get(r.code) !== r) return err(p, 'closed', 'Esta partida já foi encerrada.');
  if (spec) {
    if (!r.cfg.spec) return err(p, 'no_spec', 'Esta sala não permite espectadores.');
    if (r.players.filter(q => q.spec).length >= MAXSPEC) return err(p, 'full', 'Limite de espectadores atingido.');
  } else {
    if (r.state !== 'lobby') return err(p, 'in_progress', 'Esta partida já começou' + (r.cfg.spec ? ' (você pode assistir).' : '.'));
    if (racers(r).length >= MAXP) return err(p, 'full', 'Sala lotada (8/8).');
  }
  addPlayer(r, p, spec); checkAuto(r);
  send(p, { t: 'joined', r: roomPub(r, true), me: p.slotId, spec: !!spec });
  pushRoom(r); presence(p);
}
function startRace(r) {
  const rs = racers(r).filter(isConn);
  if (rs.length < MINP) return 'min';
  const t = trackOf(r.cfg.track);
  r.total = t.d * r.cfg.laps; r.lapLen = t.d;
  r.state = 'starting'; r.matchId = rhex(8); r.startAt = Date.now() + LEAD; r.finOrder = []; r.firstFin = 0;
  r.racers = rs.map((p, i) => { p.grid = i; p.prog = -(i < 4 ? 0 : 7); p.srv = p.prog; p.lastP = 0; p.fin = 0; p.finAt = 0; p.fl = 0; return { p, slot: p.slotId, name: p.name, car: p.car, left: false, prog: 0 }; });
  r.players.forEach(p => { if (!p.spec && !isConn(p)) p.ready = false; });
  bcast(r, { t: 'start', m: r.matchId, at: r.startAt, st: Date.now(), total: r.total, lap: r.lapLen, cfg: r.cfg, grid: r.racers.map(x => [x.slot, x.p.grid]) });
  clearTimeout(r.startT);
  r.startT = setTimeout(() => { if (r.state === 'starting') { r.state = 'racing'; presenceRoom(r); } }, LEAD);
  presenceRoom(r); return null;
}
const presenceRoom = r => r.players.forEach(presence);
function rankOrder(r) {
  const fin = r.finOrder.map(p => r.racers.find(x => x.p === p)).filter(Boolean);
  const rest = r.racers.filter(x => !r.finOrder.includes(x.p)).sort((a, b) => (b.left ? b.prog : b.p.srv) - (a.left ? a.prog : a.p.srv));
  return fin.concat(rest);
}
function endRace(r, why) {
  if (r.state === 'finished') return;
  r.state = 'finished'; clearTimeout(r.startT);
  const order = rankOrder(r), n = order.length, scale = Math.max(.25, Math.min(1, n / 8)), rows = [], rw = [];
  const minT = r.total / MAXV * 1000;
  order.forEach((x, i) => {
    const fin = r.finOrder.includes(x.p), time = fin ? Math.round(x.p.finAt - r.startAt) : null;
    const prog = Math.max(0, Math.min(r.total, fin ? r.total : (x.left ? x.prog : x.p.srv)));
    const row = { rank: i + 1, slot: x.slot, name: x.name, car: x.car, time, laps: fin ? r.cfg.laps : Math.floor(prog / r.lapLen), fin, dnf: !fin, why: fin ? '' : (x.left ? x.why : 'não terminou'), money: 0, xp: 0 };
    if (fin && time >= minT && n >= MINP) { row.money = Math.round(BASE_PRIZE[i] * scale); row.xp = Math.round(BASE_XP[i] * scale); }
    rows.push(row);
    if ((row.money || row.xp)) {
      const h = (rewardLog.get(x.p.id) || []).filter(t => Date.now() - t < 3600000);
      if (h.length < REWARD_PER_HOUR) { h.push(Date.now()); rewardLog.set(x.p.id, h); rw.push({ match_id: r.matchId, user_id: x.p.id, rank: i + 1, money: row.money, xp: row.xp }); }
      else { row.money = 0; row.xp = 0; row.cap = true; }
    }
  });
  Promise.resolve().then(() => db.saveMatch({ match_id: r.matchId, room_code: r.code, track: r.cfg.track, laps: r.cfg.laps, players: n, results: rows.map(x => ({ rank: x.rank, name: x.name, time: x.time, fin: x.fin })) })).catch(e => log('saveMatch', e.message));
  db.saveRewards(rw).then(() => {
    r.players.forEach(p => send(p, { t: 'res', m: r.matchId, rows, why }));
  }).catch(e => { log('saveRewards', e.message); rows.forEach(x => { x.money = 0; x.xp = 0; x.err = 1; }); r.players.forEach(p => send(p, { t: 'res', m: r.matchId, rows, why, rwErr: 1 })); });
  r.resetT = setTimeout(() => { if (rooms.get(r.code) === r && r.state === 'finished') resetRoom(r); }, 90000);
  presenceRoom(r);
}
function resetRoom(r) {
  if (r.state !== 'finished') return;
  clearTimeout(r.resetT); r.state = 'lobby'; r.racers = null; r.autoAt = 0;
  r.players.filter(p => p.disc).forEach(p => { p.room = null; users.delete(p.id); });
  r.players = r.players.filter(p => !(p.disc));
  r.players.forEach(p => { p.ready = !!r.auto; p.prog = 0; p.srv = 0; });
  if (!r.players.some(p => p.id === r.host)) { const h = r.players.find(p => !p.spec); if (h) r.host = h.id; }
  if (!r.players.length) return dropRoom(r, 'vazia'); pushRoom(r); checkAuto(r); presenceRoom(r);
}

/* ============================ TICK ============================ */
function tickFn() {
  const now = Date.now();
  for (const c of [...conns]) if (now - c.lastSeen > STALE) { try { c.sock.close(4010, 'stale'); } catch (e) { } }
  for (const r of [...rooms.values()]) {
    /* auto-start de salas públicas rápidas */
    if (r.auto && r.state === 'lobby' && r.autoAt && now >= r.autoAt) { r.autoAt = 0; startRace(r); }
    /* desconexões: tolerância */
    for (const p of [...r.players]) {
      if (p.disc && now - p.disc > (r.state === 'racing' || r.state === 'starting' ? GRACE_RACE : GRACE_LOBBY)) { users.delete(p.id); removePlayer(r, p, 'desconectou'); }
    }
    if (!rooms.has(r.code)) continue;
    if (r.state === 'racing') {
      /* a corrida só termina quando todo piloto ativo terminou/saiu, ou por timeout */
      const active = r.racers.filter(x => !x.left && !r.finOrder.includes(x.p) && !(x.p.disc && now - x.p.disc > GRACE_RACE));
      if (!active.length || (r.firstFin && now - r.firstFin > FIN_TIMEOUT) || now - r.startAt > RACE_MAX) endRace(r, !active.length ? 'todos' : 'tempo');
    }
    if (r.state === 'racing' || r.state === 'starting') {
      r.seq++;
      const ord = r.state === 'racing' ? rankOrder(r) : r.racers;
      const a = r.racers.map(x => { const p = x.p; const rk = ord.indexOf(x) + 1; return [x.slot, Math.round(p.srv * 10) / 10, Math.round(p.x * 10) / 10, Math.round(p.spd * 10) / 10, Math.round(p.rot * 100) / 100, p.fl | (p.disc ? 8 : 0) | (r.finOrder && r.finOrder.includes(p) ? 16 : 0), rk]; });
      const s = JSON.stringify({ t: 's', k: r.seq, st: now, a });
      r.players.forEach(p => sendRaw(p, s));
    }
  }
  for (const [c, t] of tomb) if (now - t > 600000) tomb.delete(c);
  if (!users.size && !rooms.size && !conns.size && tm) { clearInterval(tm); tm = 0; }
}
let tm = 0;
const ensureTick = () => { if (!tm) tm = setInterval(tickFn, TICK); };
const conns = new Set();

/* ============================ MENSAGENS ============================ */
async function onMsg(p, m) {
  const t = m.t;
  if (t === 'ping') { p.ping = clampI(m.rtt, 0, 5000, 0); return send(p, { t: 'pong', n: m.n, st: Date.now() }); }
  if (t === 'p') { /* snapshot de movimento do próprio jogador */
    const r = p.room; if (!r || p.spec || r.state !== 'racing' || !Array.isArray(m.a) || p.fin) return;
    const a = m.a, now = Date.now(); if (now < r.startAt - 200) return;
    let prog = +a[0], x = +a[1], spd = +a[2], rot = +a[3], fl = a[4] | 0;
    if (![prog, x, spd, rot].every(Number.isFinite)) return;
    const dt = Math.max(.02, Math.min(2, (now - (p.lastP || now - 100)) / 1000)); p.lastP = now;
    const maxAdv = MAXV * dt * 1.15 + 3;                       /* progresso plausível */
    prog = Math.min(prog, p.srv + maxAdv); prog = Math.max(prog, p.srv - 20);
    p.srv = prog; p.x = Math.max(-9, Math.min(9, x)); p.spd = Math.max(-30, Math.min(MAXV, spd)); p.rot = Math.max(-3.2, Math.min(3.2, rot)); p.fl = fl & 7;
    if (p.srv >= r.total && !p.fin) {
      p.fin = 1; p.finAt = now; r.finOrder.push(p); if (!r.firstFin) r.firstFin = now;
      bcast(r, { t: 'fin', slot: p.slotId, rank: r.finOrder.length, ms: Math.round(now - r.startAt) });
    }
    return;
  }
  if (t === 'rooms') {
    const list = [...rooms.values()].filter(r => r.pub && (r.state === 'lobby' || (r.state !== 'finished' && r.cfg.spec))).slice(0, 40).map(r => ({ ...roomPub(r, false), players: racers(r).map(q => ({ name: q.name, car: q.car && q.car.n })) }));
    return send(p, { t: 'rooms', list });
  }
  if (t === 'quick') {
    if (p.room) return err(p, 'in_room', 'Você já está em uma sala.');
    let r = [...rooms.values()].find(q => q.pub && q.auto && !q.pass && q.state === 'lobby' && racers(q).length < MAXP && q.autoAt !== -1 && (!q.autoAt || q.autoAt - Date.now() > 3000 || racers(q).length < MINP));
    if (!r) {
      const tr = TRACKS[rint(TRACKS.length)];
      r = await createRoom(p, { name: 'Corrida Rápida', pub: true, auto: true, cfg: cleanCfg({ track: tr.id, laps: 1, type: 'normal', spec: false }) });
      if (!r) return err(p, 'busy', 'Servidor ocupado.');
    }
    return joinRoom(p, r, null, false);
  }
  if (t === 'create') {
    if (p.room) return err(p, 'in_room', 'Você já está em uma sala.');
    const name = cleanName(m.name, 3, 24); if (!name) return err(p, 'bad_name', 'Nome da sala: 3 a 24 caracteres.');
    const pass = m.pass ? String(m.pass).slice(0, 16) : null;
    const r = await createRoom(p, { name, pass, pub: !!m.pub, cfg: cleanCfg(m.cfg) });
    if (!r) return err(p, 'busy', 'Servidor ocupado.');
    return joinRoom(p, r, pass, false);
  }
  if (t === 'join') {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code.length !== 6) return err(p, 'bad_code', 'Código inválido (6 caracteres).');
    const r = rooms.get(code);
    if (!r) return err(p, tomb.has(code) ? 'closed' : 'not_found', tomb.has(code) ? 'Esta partida já foi encerrada.' : 'Sala não encontrada.');
    return joinRoom(p, r, m.pass, !!m.spec);
  }
  if (t === 'leave') { const r = p.room; if (r) { removePlayer(r, p, 'saiu'); send(p, { t: 'left' }); presence(p); } return; }
  const r = p.room;
  if (t === 'ready') { if (!r || r.state !== 'lobby' || p.spec) return; p.ready = !!m.v; return pushRoom(r); }
  if (t === 'car') { if (!r || r.state !== 'lobby') return; const c = cleanCar(m.car, p.who); if (!c) return err(p, 'car_denied', 'Você não possui esse carro.'); p.car = c; return pushRoom(r); }
  if (t === 'cfg') {
    if (!r || r.host !== p.id) return err(p, 'not_host', 'Só o criador da sala pode fazer isso.');
    if (r.state !== 'lobby') return; r.cfg = cleanCfg(m.cfg, r.cfg); return pushRoom(r);
  }
  if (t === 'start') {
    if (!r || r.host !== p.id) return err(p, 'not_host', 'Só o criador da sala pode iniciar a corrida.');
    if (r.state !== 'lobby') return err(p, 'bad_state', 'A sala não está no lobby.');
    const rs = racers(r).filter(isConn); if (rs.length < MINP) return err(p, 'min_players', 'São necessários pelo menos 2 jogadores.');
    const wait = rs.filter(q => q.id !== r.host && !q.ready); if (wait.length) return err(p, 'not_ready', 'Aguardando: ' + wait.map(q => q.name).join(', '));
    const e = startRace(r); if (e) return err(p, 'min_players', 'São necessários pelo menos 2 jogadores.'); return;
  }
  if (t === 'again') { if (r && r.state === 'finished') resetRoom(r); else if (r && r.state === 'lobby') pushRoom(r); return; }
  if (t === 'claim') { try { const c = await db.claim(p.id, String(m.m || '').slice(0, 40)); send(p, { t: 'claimed', m: m.m, ok: !!c, money: c ? c.money : 0, xp: c ? c.xp : 0 }); } catch (e) { send(p, { t: 'claimed', m: m.m, ok: false, retry: 1 }); } return; }
  if (t === 'pending') { try { const l = await db.pending(p.id); send(p, { t: 'pending', list: l }); } catch (e) { } return; }
  /* ---- amigos ---- */
  if (t === 'fr') { if (!p.friends) await loadFriends(p); return sendFriends(p); }
  if (t === 'fadd') {
    const nm = cleanName(m.name, 3, 20); if (!nm) return err(p, 'bad_name', 'Digite um nome de usuário.');
    if (nm.toLowerCase() === p.name.toLowerCase()) return err(p, 'self', 'Você não pode adicionar a si mesmo.');
    let u; try { u = await db.findByName(nm); } catch (e) { return err(p, 'db', 'Erro ao buscar usuário.'); }
    if (!u) return err(p, 'no_user', 'Usuário não encontrado. (Ele precisa ter aberto o ONLINE ao menos uma vez.)');
    if (p.friends.has(u.id)) return err(p, 'already', 'Vocês já são amigos.');
    const back = p.reqIn.find(x => x.id === u.id);
    try { if (back) await db.acceptFriend(u.id, p.id); else if (!p.reqOut.find(x => x.id === u.id)) await db.insertFriend(p.id, u.id); } catch (e) { return err(p, 'db', 'Erro ao salvar.'); }
    await loadFriends(p); sendFriends(p); const q = users.get(u.id); if (q && q.ws) { await loadFriends(q); sendFriends(q); }
    return send(p, { t: 'ok', msg: back ? 'Agora vocês são amigos!' : 'Pedido enviado para ' + u.name + '.' });
  }
  if (t === 'facc' || t === 'fdec' || t === 'frem') {
    const nm = String(m.name || '').toLowerCase(); let id = null;
    for (const x of p.reqIn) if (x.name.toLowerCase() === nm) id = x.id; for (const [i, n] of p.friends) if (n.toLowerCase() === nm) id = id || i;
    if (!id) return;
    try { if (t === 'facc') await db.acceptFriend(id, p.id); else await db.deleteFriend(p.id, id); } catch (e) { return err(p, 'db', 'Erro ao salvar.'); }
    await loadFriends(p); sendFriends(p); const q = users.get(id); if (q && q.ws) { await loadFriends(q); sendFriends(q); } return;
  }
  if (t === 'inv') {
    if (!r || r.state !== 'lobby') return err(p, 'no_room', 'Entre em uma sala para convidar.');
    const nm = String(m.name || '').toLowerCase(); let id = null; for (const [i, n] of p.friends) if (n.toLowerCase() === nm) id = i;
    if (!id) return err(p, 'not_friend', 'Esse jogador não está na sua lista de amigos.');
    const q = users.get(id); if (!q || !q.ws) return err(p, 'offline', 'Seu amigo está offline.');
    r.invited.add(id); q.invites = q.invites.filter(i => i.code !== r.code).concat([{ from: p.name, code: r.code, room: r.name, at: Date.now() }]).slice(-10);
    sendFriends(q); send(q, { t: 'invite', from: p.name, code: r.code, room: r.name }); return send(p, { t: 'ok', msg: 'Convite enviado.' });
  }
  if (t === 'invdec') { p.invites = p.invites.filter(i => i.code !== String(m.code)); return sendFriends(p); }
}

/* ============================ CONEXÕES ============================ */
/* sock = { send(str), close(code, reason), readyState, bufferedAmount? } — fornecido pela casca (Worker/Node). */
function accept(sock) {
  let p = null, bucket = 60, bt = Date.now(), authing = false;
  const c = { sock, lastSeen: Date.now() }; conns.add(c); ensureTick();
  const authTimer = setTimeout(() => { if (!p) sock.close(4001, 'auth_timeout'); }, 10000);
  async function onMessage(raw) {
    const now = Date.now(); c.lastSeen = now; bucket = Math.min(80, bucket + (now - bt) / 1000 * 40); bt = now;
    if (--bucket < 0) return sock.close(4008, 'rate');
    if (typeof raw !== 'string' || raw.length > 4096) return sock.close(4011, 'size');
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      if (!p) {
        if (m.t !== 'hello' || authing) return; authing = true;
        let who; try { who = await authenticate(m.token, m.dev); } catch (e) { sock.send(JSON.stringify({ t: 'err', code: 'auth', msg: 'Sessão inválida. Entre na conta novamente.' })); return sock.close(4003, 'auth'); }
        clearTimeout(authTimer);
        const car = cleanCar(m.car, who); if (!car) { sock.send(JSON.stringify({ t: 'err', code: 'car_denied', msg: 'Você não possui esse carro.' })); return sock.close(4004, 'car'); }
        const old = users.get(who.id);
        if (old && old.ws && old.ws !== sock) { send(old, { t: 'err', code: 'elsewhere', msg: 'Sua conta entrou em outro dispositivo.' }); const ow = old.ws; old.ws = null; try { ow.close(4009, 'elsewhere'); } catch (e) { } }
        if (old) { p = old; p.ws = sock; p.disc = 0; p.car = car; p.who = who; }
        else p = { id: who.id, name: who.name, who, ws: sock, car, room: null, ping: 0, invites: [], friends: null, reqIn: [], reqOut: [], disc: 0, ready: false };
        users.set(p.id, p);
        db.upsertPlayer(p.id, p.name).catch(e => log('upsert', e.message));
        await loadFriends(p).catch(e => { p.friends = p.friends || new Map(); log('friends', e.message); });
        send(p, { t: 'welcome', id: p.id, name: p.name, st: Date.now(), max: MAXP, min: MINP });
        if (p.room) { /* reconexão: devolve o jogador à sala/corrida */
          const r = p.room; send(p, { t: 'resumed', r: roomPub(r, true), me: p.slotId, spec: p.spec });
          if (r.state === 'racing' || r.state === 'starting') send(p, { t: 'start', m: r.matchId, at: r.startAt, st: Date.now(), total: r.total, lap: r.lapLen, cfg: r.cfg, grid: r.racers.map(x => [x.slot, x.p.grid]), resume: 1, prog: p.srv });
          pushRoom(r);
        }
        presence(p); sendFriends(p); return;
      }
      await onMsg(p, m);
    } catch (e) { log('erro msg', e && e.message); }
  }
  function onClose() {
    clearTimeout(authTimer); conns.delete(c); if (!p || p.ws !== sock) return;
    p.ws = null; p.disc = Date.now();
    if (!p.room) { users.delete(p.id); presence(p); return; }
    if (p.room.state === 'racing') p.fl |= 8;
    pushRoom(p.room); presence(p);
  }
  return { onMessage, onClose };
}
const health = () => ({ ok: true, game: 'asphalt-outlaws-mp', rooms: rooms.size, players: users.size, supabase: HAVE_SB });
const shutdown = () => { rooms.forEach(r => bcast(r, { t: 'err', code: 'shutdown', msg: 'Servidor reiniciando.' })); if (tm) { clearInterval(tm); tm = 0; } };
return { accept, health, shutdown };
}
