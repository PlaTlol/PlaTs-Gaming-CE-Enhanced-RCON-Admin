'use strict';
// Wrapped in an IIFE so top-level declarations stay private and can never
// collide with the global scope (avoids "Identifier already declared" if the
// renderer ever re-evaluates the script).
(function () {
const $ = (id) => document.getElementById(id);
const api = window.api;

function showFatal(label, detail) {
  const b = document.getElementById('outBody');
  if (b) b.innerHTML = `<div class="log-entry err"><div class="log-title">${label}</div><pre class="log-raw">${detail}</pre></div>`;
}
window.onerror = (msg, src, line, col, err) => showFatal('Renderer error', `${msg} @ ${line}:${col}\n${(err && err.stack) || ''}`);
window.addEventListener('unhandledrejection', (e) => showFatal('Unhandled rejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)));
if (!window.api) showFatal('Preload missing', 'window.api is undefined — preload bridge did not load.');

let servers = [];
let activeId = null;
let players = [];
let selected = null;
let connOn = false;
let editingServerId = null; // null = add mode

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hasChar = (p) => !!(p && p.charName && String(p.charName).trim());
const pdisp = (p) => hasChar(p) ? p.charName : (p && p.playerName ? p.playerName : '(no character)');

// ---------- output log ----------
function log({ ok = true, title = '', message = '', raw = '', note = '' }) {
  const body = $('outBody');
  const hint = body.querySelector('.hint');
  if (hint) hint.remove();
  const el = document.createElement('div');
  el.className = 'log-entry ' + (ok ? 'ok' : 'err');
  el.innerHTML =
    `<div class="log-title">${esc(title)}</div>` +
    (message ? `<div class="log-msg">${esc(message)}</div>` : '') +
    (note ? `<div class="log-note">${esc(note)}</div>` : '') +
    (raw ? `<pre class="log-raw">${esc(raw)}</pre>` : '');
  body.prepend(el);
}

// ---------- server tabs ----------
function activeServer() { return servers.find((s) => s.id === activeId) || null; }

function renderTabs() {
  const nav = $('serverTabs');
  nav.innerHTML = '';
  servers.forEach((s) => {
    const tab = document.createElement('div');
    tab.className = 'stab' + (s.id === activeId ? ' active' : '');
    const dotCls = s.id === activeId ? (connOn ? 'stab-dot on' : 'stab-dot off') : 'stab-dot';
    tab.innerHTML = `<span class="${dotCls}"></span>${esc(s.name)}`;
    tab.onclick = () => switchServer(s.id);
    tab.ondblclick = () => openServerModal(s.id);
    nav.appendChild(tab);
  });
  // toggle empty-state vs action grid
  const has = servers.length > 0;
  $('emptyState').classList.toggle('hidden', has);
  $('actionGrid').classList.toggle('hidden', !has);
  $('editServerBtn').disabled = !has;
  $('refreshBtn').disabled = !has;
}

async function switchServer(id) {
  if (id === activeId) { await refreshPlayers(); refreshMiniMap(); return; }
  const cfg = await api.setActiveServer(id);
  applyCfg(cfg);
  selected = null; updateSelected();
  await refreshPlayers();
  refreshMiniMap();
}

function applyCfg(cfg) {
  servers = cfg.servers || [];
  activeId = cfg.activeServerId || (servers[0] ? servers[0].id : null);
  renderTabs();
}

// ---------- connection + players ----------
function setConn(on, text) {
  connOn = on;
  $('dot').className = 'dot ' + (on ? 'on' : 'off');
  $('connText').textContent = text;
  renderTabs();
}
async function refreshPlayers() {
  const s = activeServer();
  if (!s) { setConn(false, 'No server'); players = []; renderPlayers(); return; }
  setConn(false, `Connecting to ${s.name}…`);
  const res = await api.listPlayers();
  if (!res.ok) { setConn(false, res.message || 'Disconnected'); players = []; renderPlayers(); log({ ok: false, title: s.name, message: res.message }); return; }
  players = res.players;
  setConn(true, `${s.name} · ${players.length} online`);
  renderPlayers();
}
function renderPlayers() {
  const q = ($('playerSearch').value || '').toLowerCase();
  const ul = $('playerList');
  ul.innerHTML = '';
  $('playerCount').textContent = players.length;
  players
    .filter((p) => !q || p.charName.toLowerCase().includes(q) || p.playerName.toLowerCase().includes(q))
    .forEach((p) => {
      const li = document.createElement('li');
      if (selected && selected.idx === p.idx && selected.userId === p.userId) li.className = 'active';
      li.innerHTML = `<span class="pl-name">${esc(pdisp(p))}</span><span class="pl-sub">${esc(hasChar(p) ? p.playerName : 'no character yet')} · idx ${p.idx}</span>`;
      li.onclick = () => selectPlayer(p);
      li.oncontextmenu = (e) => showCtxMenu(e, p);
      ul.appendChild(li);
    });
  updateActing();
}
async function selectPlayer(p) {
  const res = await api.resolvePlayer(p);
  selected = res.ok ? res.target : { ...p, dbId: null };
  updateSelected();
  renderPlayers();
}
function updateSelected() {
  $('selName').textContent = selected ? pdisp(selected) : '— none —';
  const meta = $('selMeta');
  meta.textContent = selected ? `idx ${selected.idx} · userId ${selected.userId} · dbId ${selected.dbId ?? '—'}` : '';
  meta.title = selected ? 'Click to copy SteamID / User ID' : '';
  meta.style.cursor = selected ? 'pointer' : 'default';
  meta.onclick = selected ? () => copyText(selected.platformId || selected.userId, selected.platformId ? 'SteamID' : 'User ID') : null;
}
function requireTarget() { if (!selected) { log({ ok: false, title: 'No target', message: 'Select an online player first.' }); return false; } return true; }
function requireDbId() { if (!requireTarget()) return false; if (selected.dbId == null) { log({ ok: false, title: 'No DB record', message: `${selected.charName} isn't in the character DB yet.` }); return false; } return true; }

// ---------- action dispatch ----------
const ACTIONS = {
  kick: async () => requireTarget() && doKick(),
  kill: async () => requireTarget() && confirmThen('Kill Player', `Kill ${selected.charName}?`, () => run('Kill', api.kill(selected))),
  teleportTo: async () => requireDbId() && run('Teleport to Player', api.teleportTo(selected)),
  summon: async () => requireTarget() && run('Summon Player', api.summon(selected)),
  sendHome: async () => requireDbId() && run('Send Home', api.sendHome(selected)),
  editCharacter: async () => requireDbId() && openEdit(),
  deleteCharacter: async () => requireDbId() && confirmThen('Delete Character', `PERMANENTLY delete ${selected.charName} (dbId ${selected.dbId}) and all related data? This cannot be undone.`, () => run('Delete Character', api.deleteCharacter(selected))),
  removeBuildings: async () => requireDbId() && confirmThen('Remove Buildings', `Destroy ALL buildings owned by ${selected.charName}?`, () => run('Remove Buildings', api.removeBuildings(selected))),
  clearCooldowns: async () => requireDbId() && run('Clear Cooldowns', api.clearCooldowns(selected)),
  viewFeats: async () => requireDbId() && showData(await api.viewFeats(selected)),
  viewQuestFlags: async () => requireDbId() && showData(await api.viewQuestFlags(selected)),
  viewInventory: async () => requireDbId() && showInventory(await api.viewInventory(selected)),
  heatmap: async () => openHeatmap(),
  dashboard: async () => showDashboard(),
  banManager: async () => showBanManager(),
  playerFinder: async () => showPlayerFinder(),
  buildingReport: async () => showBuildingReport(),
  raidLog: async () => showRaidLog(),
  clanManager: async () => showClanManager(),
  broadcast: async () => showBroadcast(),
  rconConsole: async () => showRconConsole(),
};
document.querySelectorAll('.act-btn').forEach((btn) => {
  btn.onclick = async () => {
    if (!activeServer()) { log({ ok: false, title: 'No server', message: 'Add and select a server first.' }); return; }
    const act = btn.dataset.act;
    btn.disabled = true;
    try { await ACTIONS[act](); }
    catch (e) { log({ ok: false, title: act, message: e.message || String(e) }); }
    finally { btn.disabled = false; }
  };
});
// Custom line-style SVG icons (cardinal-red theme, inherit currentColor).
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  // Server
  dashboard: SVG('<path d="M3 21h18"/><path d="M6 21v-7"/><path d="M11 21V5"/><path d="M16 21v-10"/>'),
  banManager: SVG('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  playerFinder: SVG('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  buildingReport: SVG('<path d="M3 21h18"/><path d="M6 21V8l6-4 6 4v13"/><path d="M10 12h4M10 16h4"/>'),
  raidLog: SVG('<path d="M6 4l11 11M18 4L7 15"/><path d="M3.5 17.5l3 3M20.5 17.5l-3 3"/>'),
  clanManager: SVG('<path d="M12 2l8 3v6c0 5-3.5 8-8 11-4.5-3-8-6-8-11V5z"/>'),
  broadcast: SVG('<path d="M3 10v4l12 5V5L3 10z"/><path d="M15 8a4 4 0 0 1 0 8"/><path d="M6 14v3a1.5 1.5 0 0 0 3 0v-2"/>'),
  rconConsole: SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  // Punishments
  kick: SVG('<path d="M14 3h5v18h-5"/><path d="M3 12h11M10 8l4 4-4 4"/>'),
  kill: SVG('<circle cx="12" cy="10" r="7"/><circle cx="9" cy="10" r="1.4" fill="currentColor"/><circle cx="15" cy="10" r="1.4" fill="currentColor"/><path d="M8 18v2M12 18v2M16 18v2M7 17h10"/>'),
  // Interactions
  teleportTo: SVG('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>'),
  summon: SVG('<path d="M12 3v10M8 9l4 4 4-4"/><path d="M5 19h14"/>'),
  sendHome: SVG('<path d="M3 11l9-8 9 8"/><path d="M5 9v11h14V9"/><path d="M10 20v-6h4v6"/>'),
  // Tools
  editCharacter: SVG('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  deleteCharacter: SVG('<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>'),
  removeBuildings: SVG('<path d="M3 5h18v14H3z"/><path d="M3 12h18M9 5v7M16 12v7M12 12V5"/>'),
  clearCooldowns: SVG('<path d="M20 6.5A8 8 0 1 0 21 12"/><path d="M21 3v4h-4"/><path d="M12 8v4l3 2"/>'),
  viewFeats: SVG('<path d="M12 2.5l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 16.8 6.4 19.7l1.1-6.2L3 9.1l6.2-.9z"/>'),
  heatmap: SVG('<path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/>'),
  viewQuestFlags: SVG('<path d="M5 21V3"/><path d="M5 4h12l-2.5 3.5L17 11H5"/>'),
  viewInventory: SVG('<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>'),
};
// Per-action icon colors — varied but theme-coherent (vivid on dark bg).
const ICON_COLORS = {
  dashboard: '#5b9df0', banManager: '#e0243f', playerFinder: '#34d3c0',
  buildingReport: '#f5c542', raidLog: '#f0832f', clanManager: '#a779f0',
  broadcast: '#5b9df0', rconConsole: '#4ade80',
  kick: '#f0832f', kill: '#e0243f',
  teleportTo: '#a779f0', summon: '#5b9df0', sendHome: '#4ade80',
  editCharacter: '#5b9df0', deleteCharacter: '#e0243f', removeBuildings: '#f0832f',
  clearCooldowns: '#34d3c0', viewFeats: '#f5c542', heatmap: '#ee6aa7',
  viewQuestFlags: '#4ade80', viewInventory: '#f59e7a',
};
function applyIcons() {
  document.querySelectorAll('.act-btn').forEach((b) => {
    const ico = ICONS[b.dataset.act];
    const span = b.querySelector('.act-ico');
    if (ico && span) { span.innerHTML = ico; if (ICON_COLORS[b.dataset.act]) span.style.color = ICON_COLORS[b.dataset.act]; }
  });
}
applyIcons();

async function run(title, promise) {
  const res = await promise;
  log({ ok: res.ok, title: res.title || title, message: res.message, raw: res.raw, note: res.note });
  return res;
}
async function confirmThen(title, message, fn) { if (await api.confirm({ title, message })) await fn(); }
async function doKick() {
  const msg = prompt(`Kick message for ${selected.charName}:`, 'Kicked by admin');
  if (msg === null) return;
  await run('Kick', api.kick(selected, msg));
}

// ---------- data modal ----------
function showData(res) {
  if (!res) return;
  if (!res.ok) { log({ ok: false, title: res.title || 'Error', message: res.message }); return; }
  $('dataTitle').textContent = res.title || 'Data';
  const body = $('dataBody');
  body.innerHTML = '';
  if (res.note) body.appendChild(noteEl(res.note));
  if (res.table) body.appendChild(tableEl(res.table));
  if (res.extra && res.extra.rows && res.extra.rows.length) { body.appendChild(subhead('Progression properties')); body.appendChild(tableEl(res.extra)); }
  if (res.detail && res.detail.rows && res.detail.rows.length) { body.appendChild(subhead('Items (first 200)')); body.appendChild(tableEl(res.detail)); }
  if ((!res.table || !res.table.rows.length) && (!res.detail || !res.detail.rows.length)) body.appendChild(noteEl('No rows returned.'));
  $('dataModal').classList.remove('hidden');
}
function subhead(t) { const d = document.createElement('div'); d.className = 'note'; d.textContent = t; return d; }
function noteEl(t) { const d = document.createElement('div'); d.className = 'note'; d.textContent = t; return d; }
function tableEl(tbl) {
  const table = document.createElement('table'); table.className = 'grid';
  const thead = document.createElement('thead'); const trh = document.createElement('tr');
  tbl.columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; trh.appendChild(th); });
  thead.appendChild(trh); table.appendChild(thead);
  const tb = document.createElement('tbody');
  tbl.rows.forEach((r) => { const tr = document.createElement('tr'); tbl.columns.forEach((c) => { const td = document.createElement('td'); td.textContent = r[c]; tr.appendChild(td); }); tb.appendChild(tr); });
  table.appendChild(tb); return table;
}
$('closeData').onclick = () => $('dataModal').classList.add('hidden');

// ---------- inventory view (item cards + icons) ----------
let _itemDb = null;
async function getItemDb() { if (!_itemDb) _itemDb = (await api.itemDb()) || {}; return _itemDb; }
const _iconCache = new Map();
async function setIcon(imgEl, file) {
  if (!file) return;
  let data = _iconCache.get(file);
  if (data === undefined) { data = await api.itemIcon(file); _iconCache.set(file, data); }
  if (data) imgEl.src = data; else imgEl.classList.add('inv-ico-missing');
}
async function showInventory(res) {
  if (!res) return;
  if (!res.ok) { log({ ok: false, title: res.title || 'Inventory', message: res.message }); return; }
  $('dataTitle').textContent = res.title || 'Inventory';
  const body = $('dataBody'); body.innerHTML = '';
  if (!res.items || !res.items.length) { body.appendChild(noteEl('This character has no items.')); $('dataModal').classList.remove('hidden'); return; }
  const db = await getItemDb();
  const groups = {};
  for (const it of res.items) { (groups[it.invType] = groups[it.invType] || { name: it.container, items: [] }).items.push(it); }
  const sum = document.createElement('div'); sum.className = 'note';
  sum.textContent = `${res.items.length} distinct items · ${res.total} total stacks · icons load from the community item DB (cached after first view)`;
  body.appendChild(sum);
  const pending = [];
  Object.keys(groups).sort((a, b) => a - b).forEach((k) => {
    const g = groups[k];
    const h = document.createElement('div'); h.className = 'inv-group-title'; h.textContent = `${g.name} — ${g.items.length}`;
    body.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'inv-grid';
    g.items.forEach((it) => {
      const meta = db[it.templateId];
      const card = document.createElement('div'); card.className = 'inv-card';
      card.title = meta ? `${meta.n}${meta.c ? ' · ' + meta.c : ''} · id ${it.templateId}` : `Unknown item · id ${it.templateId}`;
      const img = document.createElement('img'); img.className = 'inv-ico'; img.alt = '';
      const nm = document.createElement('div'); nm.className = 'inv-name'; nm.textContent = meta ? meta.n : `#${it.templateId}`;
      card.appendChild(img); card.appendChild(nm);
      if (it.stacks > 1) { const q = document.createElement('div'); q.className = 'inv-qty'; q.textContent = '×' + it.stacks; card.appendChild(q); }
      grid.appendChild(card);
      if (meta && meta.i) pending.push([img, meta.i]); else img.classList.add('inv-ico-missing');
    });
    body.appendChild(grid);
  });
  $('dataModal').classList.remove('hidden');
  // fetch icons with limited concurrency (gentle on the CDN; cached by main)
  let idx = 0;
  const worker = async () => { while (idx < pending.length) { const [img, file] = pending[idx++]; await setIcon(img, file); } };
  for (let i = 0; i < 8; i++) worker();
}

// ---------- edit character ----------
function openEdit() {
  $('dataTitle').textContent = `Edit Character: ${selected.charName}`;
  const body = $('dataBody'); body.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'edit-grid';
  wrap.innerHTML =
    `<label>Character name <input id="edName" value="${esc(selected.charName)}" /></label>` +
    `<label>Level <input id="edLevel" type="number" min="0" max="60" value="${esc(selected.dbLevel ?? '')}" /></label>` +
    `<label>Alive <select id="edAlive"><option value="">(unchanged)</option><option value="1">Alive</option><option value="0">Dead</option></select></label>` +
    `<div class="note">Writes to the characters table. Player should relog for changes to fully apply.</div>`;
  body.appendChild(wrap);
  const btn = document.createElement('button'); btn.className = 'primary-btn'; btn.textContent = 'Apply changes'; btn.style.marginTop = '12px';
  btn.onclick = async () => {
    const fields = { char_name: $('edName').value, level: $('edLevel').value, isAlive: $('edAlive').value };
    $('dataModal').classList.add('hidden');
    await run('Edit Character', api.editCharacter(selected, fields));
    selected.charName = fields.char_name || selected.charName; updateSelected();
  };
  body.appendChild(btn);
  $('dataModal').classList.remove('hidden');
}

// ---------- server dashboard ----------
async function showDashboard() {
  $('dataTitle').textContent = 'Server Dashboard';
  const body = $('dataBody'); body.innerHTML = '<div class="note">Loading server stats…</div>';
  $('dataModal').classList.remove('hidden');
  const d = await api.dashboard();
  body.innerHTML = '';
  if (!d.ok) { body.appendChild(noteEl(d.message || 'Error loading dashboard.')); return; }
  const stats = [
    ['Online now', d.online], ['Characters', d.chars], ['Alive', d.alive], ['Dead', d.dead],
    ['Clans', d.clans], ['Build pieces', d.buildings], ['Builders', d.builders],
    ['Active 7d', d.active7], ['Active 30d', d.active30], ['Bans', d.bans],
  ];
  const grid = document.createElement('div'); grid.className = 'stat-grid';
  stats.forEach(([k, v]) => { const c = document.createElement('div'); c.className = 'stat-card'; c.innerHTML = `<div class="stat-val">${v}</div><div class="stat-key">${esc(k)}</div>`; grid.appendChild(c); });
  body.appendChild(grid);
  if (d.players && d.players.length) {
    body.appendChild(subhead(`Online now (${d.players.length})`));
    const ul = document.createElement('div'); ul.className = 'dash-online';
    d.players.forEach((p) => { const el = document.createElement('div'); el.className = 'dash-pl'; el.innerHTML = `<b>${esc(p.charName)}</b><span class="muted">${esc(p.playerName)}</span>`; ul.appendChild(el); });
    body.appendChild(ul);
  }
}

// ---------- ban / whitelist manager ----------
async function showBanManager() {
  $('dataTitle').textContent = 'Ban / Whitelist Manager';
  const body = $('dataBody'); body.innerHTML = '<div class="note">Loading bans…</div>';
  $('dataModal').classList.remove('hidden');
  async function refresh() {
    const res = await api.listBans();
    body.innerHTML = '';
    let opts = '<option value="">— pick an online player —</option>';
    players.forEach((p) => { if (p.platformId) opts += `<option value="${esc(p.platformId)}">${esc(p.charName)} (${esc(p.platformId)})</option>`; });
    const form = document.createElement('div'); form.className = 'ban-form';
    form.innerHTML =
      `<div class="inv-group-title">Ban a player</div>` +
      `<div class="ban-row"><select id="banPick">${opts}</select>` +
      `<input id="banId" placeholder="…or paste SteamID / platformId" />` +
      `<input id="banReason" placeholder="reason (optional)" /></div>` +
      `<div class="ban-row"><button id="banBtn" class="primary-btn">Ban</button>` +
      `<button id="wlAddBtn" class="mini-btn" style="flex:0 0 auto">Whitelist +</button>` +
      `<button id="wlRmBtn" class="mini-btn" style="flex:0 0 auto">Whitelist −</button>` +
      `<span id="banMsg" class="muted"></span></div>`;
    body.appendChild(form);
    body.appendChild(subhead(`Current bans (${res.ok ? res.bans.length : 0})`));
    if (res.ok && res.bans.length) {
      const list = document.createElement('div'); list.className = 'ban-list';
      res.bans.forEach((b) => {
        const row = document.createElement('div'); row.className = 'ban-item';
        row.innerHTML = `<span><b>${esc(b.name || 'Unknown')}</b> <span class="muted">${esc(b.platformId)}</span></span>`;
        const ub = document.createElement('button'); ub.className = 'mini-btn'; ub.style.flex = '0 0 auto'; ub.textContent = 'Unban';
        ub.onclick = async () => { await api.unban(b.platformId); refresh(); };
        row.appendChild(ub); list.appendChild(row);
      });
      body.appendChild(list);
    } else body.appendChild(noteEl(res.ok ? 'No active bans.' : res.message));
    body.appendChild(noteEl('Whitelist can be added/removed, but the game does not expose the current whitelist over RCON — so it cannot be listed here.'));
    const pickId = () => ($('banId').value.trim() || $('banPick').value);
    const pickLabel = () => ($('banPick').selectedOptions[0] && $('banPick').value ? $('banPick').selectedOptions[0].textContent : pickId());
    $('banBtn').onclick = async () => {
      const id = pickId(); if (!id) { $('banMsg').textContent = 'pick or enter an ID'; return; }
      if (!(await api.confirm({ title: 'Ban player', message: `Ban ${pickLabel()}?` }))) return;
      const r = await api.ban({ selector: 'platformid', id, reason: $('banReason').value, label: pickLabel() });
      log({ ok: r.ok, title: 'Ban', message: r.message, raw: r.raw }); refresh();
    };
    $('wlAddBtn').onclick = async () => { const id = pickId(); if (!id) return; const r = await api.whitelist(id, true); $('banMsg').textContent = r.message; log({ ok: r.ok, title: 'Whitelist', message: r.message }); };
    $('wlRmBtn').onclick = async () => { const id = pickId(); if (!id) return; const r = await api.whitelist(id, false); $('banMsg').textContent = r.message; log({ ok: r.ok, title: 'Whitelist', message: r.message }); };
  }
  await refresh();
}

// ---------- player finder ----------
function timeAgo(epoch) {
  const s = Math.floor(Date.now() / 1000) - epoch;
  if (s < 0) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
async function showPlayerFinder() {
  $('dataTitle').textContent = 'Player Finder';
  const body = $('dataBody'); body.innerHTML = '';
  $('dataModal').classList.remove('hidden');
  const bar = document.createElement('div'); bar.className = 'find-bar';
  bar.innerHTML = `<input id="findQ" placeholder="Search character name… (offline players too)" /><button id="findBtn" class="primary-btn">Search</button>`;
  body.appendChild(bar);
  const results = document.createElement('div'); results.id = 'findResults'; body.appendChild(results);
  const onlineIds = new Set(players.map((p) => p.userId));
  async function run() {
    const q = $('findQ').value.trim();
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '<div class="note">Searching…</div>';
    const res = await api.findChars(q);
    results.innerHTML = '';
    if (!res.ok) { results.appendChild(noteEl(res.message)); return; }
    if (!res.rows.length) { results.appendChild(noteEl('No characters match.')); return; }
    results.appendChild(noteEl(`${res.rows.length} result(s) — click one to make it the selected target.`));
    res.rows.forEach((r) => {
      const online = r.userId && onlineIds.has(r.userId);
      const alive = (r.isAlive === '1' || r.isAlive === 1);
      const row = document.createElement('div'); row.className = 'find-row';
      row.innerHTML =
        `<span class="find-dot ${online ? 'on' : 'off'}"></span>` +
        `<span class="find-name">${esc(r.charName)}</span>` +
        `<span class="muted">Lvl ${esc(r.level)} · ${alive ? 'alive' : 'dead'} · ${online ? 'ONLINE' : 'last ' + (r.last ? timeAgo(r.last) : '—')}</span>` +
        `<span class="muted find-id">id ${r.dbId}</span>`;
      row.onclick = () => {
        const onlineP = players.find((p) => p.userId === r.userId);
        selected = onlineP
          ? { ...onlineP, dbId: r.dbId, dbLevel: r.level }
          : { idx: undefined, charName: r.charName, playerName: '', userId: r.userId, platformId: r.platformId, dbId: r.dbId, dbLevel: r.level };
        updateSelected(); renderPlayers();
        $('dataModal').classList.add('hidden');
        log({ ok: true, title: 'Selected', message: `${r.charName} is now the target${online ? '' : ' (offline — Edit/Delete/Remove Buildings/View Inventory & Feats work; Teleport/Summon/Kick need them online)'}.` });
      };
      results.appendChild(row);
    });
  }
  $('findBtn').onclick = run;
  $('findQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  setTimeout(() => $('findQ').focus(), 50);
}

// ---------- building / land-claim report ----------
function selectOwner(o) {
  selected = { idx: undefined, charName: o.name, playerName: o.type, userId: null, platformId: null, dbId: o.ownerId, dbLevel: null };
  updateSelected(); renderPlayers();
  $('dataModal').classList.add('hidden');
  log({ ok: true, title: 'Owner selected', message: `${o.name} (${o.type}, id ${o.ownerId}) is the target — use "Remove Buildings" to clear their ${o.pieces} pieces.` });
}
async function showBuildingReport() {
  $('dataTitle').textContent = 'Building / Land-Claim Report';
  const body = $('dataBody'); body.innerHTML = '<div class="note">Counting buildings…</div>';
  $('dataModal').classList.remove('hidden');
  const r = await api.buildingReport();
  body.innerHTML = '';
  if (!r.ok) { body.appendChild(noteEl(r.message || 'Error')); return; }
  body.appendChild(noteEl(`${r.totalPieces.toLocaleString()} building pieces (in ${r.totalObjects.toLocaleString()} structures/placeables) across ${r.ownerCount} owners. "Pieces" = actual placed pieces; "Objects" = structures + standalone placeables. Red rows = Player idle 14+ days. Click a row to target that owner.`));
  const ctl = document.createElement('div'); ctl.className = 'heat-controls';
  ctl.innerHTML = `<label class="muted" style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="brIdle"> Idle players only (14d+)</label>`;
  body.appendChild(ctl);
  const tbl = document.createElement('table'); tbl.className = 'grid'; body.appendChild(tbl);
  function render() {
    const idleOnly = $('brIdle').checked;
    let rows = r.owners;
    if (idleOnly) rows = rows.filter((o) => o.type === 'Player' && o.idleDays != null && o.idleDays >= 14);
    tbl.innerHTML = '<thead><tr><th>Owner</th><th>Type</th><th>Pieces</th><th>Objects</th><th>Last online</th></tr></thead>';
    const tb = document.createElement('tbody');
    rows.slice(0, 500).forEach((o) => {
      const tr = document.createElement('tr');
      const lastTxt = o.type === 'Player' ? (o.last ? timeAgo(o.last) + (o.idleDays >= 14 ? ' ⚠' : '') : '—') : '(clan)';
      tr.innerHTML = `<td>${esc(o.name)}</td><td>${o.type}</td><td>${o.pieces.toLocaleString()}</td><td>${o.objects.toLocaleString()}</td><td>${lastTxt}</td>`;
      if (o.type === 'Player' && o.idleDays != null && o.idleDays >= 14) tr.style.background = 'rgba(196,30,58,.10)';
      tr.style.cursor = 'pointer';
      tr.onclick = () => selectOwner(o);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
  }
  $('brIdle').onchange = render;
  render();
}

// ---------- raid / destruction log ----------
// Best-effort labels inferred from each event type's data signature (Conan
// strips the official enum names from shipping builds). Unknowns show #code.
const RL_LABELS = {
  86: 'Creature killed', 87: 'Item picked up', 88: 'Building piece', 89: 'Combat event',
  91: 'Item taken (container)', 92: 'Item picked up', 93: 'Container looted',
  94: 'Item stored (container)', 99: 'Container/door opened', 103: 'Player died',
  109: 'Combat event', 111: 'Building event', 113: 'Pet died', 114: 'Thrall killed',
  115: 'Pet killed', 116: 'Thrall knocked out', 122: 'Thrall event', 171: 'Building event',
  172: 'Building event', 173: 'Building event', 174: 'Building event', 177: 'Item crafted',
};
function RL_LABEL(t) { return RL_LABELS[t] || ('event #' + t); }
// Clean an objectName: numeric -> item name (via item DB); class -> readable.
function prettyObj(o, db) {
  if (!o) return '';
  if (/^-?\d+$/.test(o)) { const m = db && db[o]; return m ? m.n : '#' + o; }
  return String(o).replace(/_C$/, '').replace(/^(Wildlife_|pet_|BP_|Persistent|SK_)/, '').replace(/_+/g, ' ').trim();
}
async function showRaidLog() {
  $('dataTitle').textContent = 'Raid & Destruction Log';
  const body = $('dataBody'); body.innerHTML = ''; $('dataModal').classList.remove('hidden');
  let offset = 0, filter = '', raidsOnly = true;
  const bar = document.createElement('div'); bar.className = 'find-bar';
  bar.innerHTML = `<input id="rlQ" placeholder="filter by player / clan / object…" /><label class="muted" style="display:flex;align-items:center;gap:5px;white-space:nowrap"><input type="checkbox" id="rlRaids" checked> cross-clan only</label><button id="rlGo" class="primary-btn">Search</button>`;
  body.appendChild(bar);
  body.appendChild(noteEl('Most recent first. "Attacker → Target". Event names are inferred from the event data — Conan doesn’t publish the codes — so they\'re best-effort (the # code is kept for reference).'));
  const list = document.createElement('div'); list.id = 'rlList'; body.appendChild(list);
  const moreWrap = document.createElement('div'); moreWrap.style.textAlign = 'center'; moreWrap.style.marginTop = '10px'; body.appendChild(moreWrap);
  const more = document.createElement('button'); more.className = 'mini-btn'; more.style.width = 'auto'; more.textContent = 'Load more';
  more.onclick = () => load(false);
  const db = await getItemDb();
  async function load(reset) {
    if (reset) { offset = 0; list.innerHTML = '<div class="note">Loading…</div>'; }
    const res = await api.raidLog({ offset, filter, raidsOnly });
    if (reset) list.innerHTML = '';
    if (!res.ok) { list.appendChild(noteEl(res.message)); return; }
    if (reset && !res.events.length) { list.appendChild(noteEl('No matching events.')); }
    res.events.forEach((e) => {
      const row = document.createElement('div'); row.className = 'rl-row';
      const who = e.causer ? `<b style="color:#ff8a6a">${esc(e.causer)}</b>${e.causerGuild ? ` <span class="muted">[${esc(e.causerGuild)}]</span>` : ''}` : '<span class="muted">—</span>';
      const vic = e.owner ? `<b style="color:#facc15">${esc(e.owner)}</b>${e.ownerGuild ? ` <span class="muted">[${esc(e.ownerGuild)}]</span>` : ''}` : (e.ownerGuild ? `<span class="muted">[${esc(e.ownerGuild)}]</span>` : '<span class="muted">—</span>');
      const obj = prettyObj(e.object, db);
      row.innerHTML = `<span class="rl-time muted">${e.time ? timeAgo(e.time) : ''}</span><span class="rl-main">${who} → ${vic} <span class="rl-type">${esc(RL_LABEL(e.type))}</span>${obj ? ` <span class="muted">· ${esc(obj)}</span>` : ''} <span class="rl-code">#${e.type}</span></span>`;
      list.appendChild(row);
    });
    moreWrap.innerHTML = '';
    if (res.events.length >= res.limit) { offset += res.limit; moreWrap.appendChild(more); }
  }
  const go = () => { filter = $('rlQ').value.trim(); raidsOnly = $('rlRaids').checked; load(true); };
  $('rlGo').onclick = go;
  $('rlQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  load(true);
}

// ---------- clan / guild manager ----------
async function showClanManager() {
  $('dataTitle').textContent = 'Clan Manager';
  const body = $('dataBody'); body.innerHTML = '<div class="note">Loading clans…</div>'; $('dataModal').classList.remove('hidden');
  const r = await api.clanList();
  body.innerHTML = '';
  if (!r.ok) { body.appendChild(noteEl(r.message)); return; }
  const bar = document.createElement('div'); bar.className = 'find-bar';
  bar.innerHTML = `<input id="clanQ" placeholder="filter clans by name or owner…" /><span class="muted" style="white-space:nowrap">${r.clans.length} clans</span>`;
  body.appendChild(bar);
  const tbl = document.createElement('table'); tbl.className = 'grid'; body.appendChild(tbl);
  function render() {
    const q = ($('clanQ').value || '').toLowerCase();
    const rows = r.clans.filter((c) => !q || c.name.toLowerCase().includes(q) || c.owner.toLowerCase().includes(q));
    tbl.innerHTML = '<thead><tr><th>Clan</th><th>Owner</th><th>Members</th><th>Pieces</th><th></th></tr></thead>';
    const tb = document.createElement('tbody');
    rows.slice(0, 400).forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><b>${esc(c.name)}</b> <span class="muted">#${c.id}</span></td><td>${esc(c.owner)}</td><td>${c.members}</td><td>${c.buildings}</td>`;
      const td = document.createElement('td'); td.style.whiteSpace = 'nowrap';
      const mk = (lbl, fn) => { const b = document.createElement('button'); b.className = 'mini-btn'; b.style.flex = '0 0 auto'; b.style.marginLeft = '4px'; b.textContent = lbl; b.onclick = fn; return b; };
      td.appendChild(mk('Members', () => showClanMembers(c)));
      td.appendChild(mk('Rename', () => renameClan(c)));
      td.appendChild(mk('Disband', () => disbandClan(c)));
      tr.appendChild(td); tb.appendChild(tr);
    });
    tbl.appendChild(tb);
  }
  $('clanQ').addEventListener('input', render);
  render();
}
async function showClanMembers(c) {
  $('dataTitle').textContent = `Clan: ${c.name}`;
  const body = $('dataBody'); body.innerHTML = '<div class="note">Loading members…</div>';
  const r = await api.clanMembers(c.id);
  body.innerHTML = '';
  const back = document.createElement('button'); back.className = 'mini-btn'; back.style.width = 'auto'; back.textContent = '← Back to clans'; back.onclick = () => showClanManager();
  body.appendChild(back);
  body.appendChild(subhead(`${c.name} — owner ${c.owner} — ${r.ok ? r.members.length : 0} members`));
  if (r.ok && r.members.length) {
    const tbl = document.createElement('table'); tbl.className = 'grid';
    tbl.innerHTML = '<thead><tr><th>Member</th><th>Lvl</th><th>Last online</th><th></th></tr></thead>';
    const tb = document.createElement('tbody');
    r.members.forEach((m) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><b>${esc(m.charName)}</b> <span class="muted">#${m.dbId}</span></td><td>${esc(m.level)}</td><td>${m.last ? timeAgo(m.last) : '—'}</td>`;
      const td = document.createElement('td'); td.style.whiteSpace = 'nowrap';
      const ob = document.createElement('button'); ob.className = 'mini-btn'; ob.style.flex = '0 0 auto'; ob.textContent = 'Make owner';
      ob.onclick = async () => { if (await api.confirm({ title: 'Set clan owner', message: `Make ${m.charName} owner of ${c.name}?` })) { const res = await api.setGuildOwner(c.id, m.dbId); log({ ok: res.ok, title: 'Clan owner', message: res.message, note: res.note }); showClanMembers(c); } };
      const sel = document.createElement('button'); sel.className = 'mini-btn'; sel.style.flex = '0 0 auto'; sel.style.marginLeft = '4px'; sel.textContent = 'Target';
      sel.onclick = () => { selected = { idx: undefined, charName: m.charName, playerName: '', userId: null, platformId: null, dbId: m.dbId, dbLevel: m.level }; updateSelected(); renderPlayers(); $('dataModal').classList.add('hidden'); log({ ok: true, title: 'Selected', message: `${m.charName} is the target.` }); };
      td.appendChild(ob); td.appendChild(sel); tr.appendChild(td); tb.appendChild(tr);
    });
    tbl.appendChild(tb); body.appendChild(tbl);
  } else body.appendChild(noteEl('No members found.'));
}
async function renameClan(c) {
  const nm = prompt(`Rename clan "${c.name}" to:`, c.name);
  if (nm === null || !nm.trim()) return;
  const r = await api.renameGuild(c.id, nm.trim());
  log({ ok: r.ok, title: 'Rename clan', message: r.message, note: r.note, raw: r.raw });
  showClanManager();
}
async function disbandClan(c) {
  if (!(await api.confirm({ title: 'Disband clan', message: `PERMANENTLY disband "${c.name}" (#${c.id})? Removes the clan and unassigns its ${c.members} member(s); their clan-owned buildings become ownerless. Cannot be undone.` }))) return;
  const r = await api.disbandGuild(c.id);
  log({ ok: r.ok, title: 'Disband clan', message: r.message, note: r.note, raw: r.raw });
  showClanManager();
}

// ---------- heatmap ----------
// Both maps live in one merged "Enhanced" world; Siptah is offset at x≈+1.58M.
// Calibration is stored per map as offsets (dx,dy) from a base center so the
// sliders stay usable even for Siptah's far-away coordinates.
const MAP_DEFS = {
  exiled: { img: 'assets/maps/exiled.jpg', base: { cx: 0, cy: 0 }, span: 820000 },
  siptah: { img: 'assets/maps/siptah.jpg', base: { cx: 1578000, cy: 115000 }, span: 720000 },
};
function loadCal(mapKey) {
  const def = { dx: 0, dy: 0, span: MAP_DEFS[mapKey].span, flipY: false };
  try { const j = JSON.parse(localStorage.getItem('heatcal_' + mapKey)); if (j) return { ...def, ...j }; } catch (e) {}
  return def;
}
function saveCal(mapKey, cal) { try { localStorage.setItem('heatcal_' + mapKey, JSON.stringify(cal)); } catch (e) {} }
function effCal(mapKey, cal) { const b = MAP_DEFS[mapKey].base; return { cx: b.cx + cal.dx, cy: b.cy + cal.dy, span: cal.span, flipY: cal.flipY }; }
function loadImage(src) {
  return new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
}

async function openHeatmap() {
  $('dataTitle').textContent = 'Building Heatmap';
  const body = $('dataBody');
  body.innerHTML = '<div class="note">Loading building positions & map…</div>';
  $('dataModal').classList.remove('hidden');

  let mapKey = 'exiled';
  let cal = loadCal(mapKey);
  let cells = []; let curBin = 7000; let bg = 'map';
  const imgCache = {};
  const curImg = async () => { if (!(mapKey in imgCache)) imgCache[mapKey] = await loadImage(MAP_DEFS[mapKey].img); return imgCache[mapKey]; };
  let mapImg = await curImg();

  body.innerHTML = '';
  const controls = document.createElement('div'); controls.className = 'heat-controls';
  controls.innerHTML =
    `<select id="heatOwner"><option value="">All players</option></select>` +
    `<select id="heatMap"><option value="exiled">Exiled Lands</option><option value="siptah">Isle of Siptah</option></select>` +
    `<select id="heatBg"><option value="map">Map image</option><option value="none">Scatter</option></select>` +
    `<button id="heatReload" class="mini-btn" style="flex:0 0 auto">Reload</button>` +
    `<span id="heatCount" class="muted"></span>`;
  body.appendChild(controls);

  const calRow = document.createElement('div'); calRow.className = 'heat-controls'; calRow.id = 'calRow';
  calRow.innerHTML =
    `<span class="muted">Align&nbsp;to&nbsp;map:</span>` +
    `<label class="muted">Zoom<input id="calSpan" type="range" min="200000" max="1300000" step="5000"></label>` +
    `<label class="muted">X<input id="calX" type="range" min="-400000" max="400000" step="5000"></label>` +
    `<label class="muted">Y<input id="calY" type="range" min="-400000" max="400000" step="5000"></label>` +
    `<label class="muted">Flip&nbsp;Y<input id="calFlip" type="checkbox"></label>` +
    `<button id="calReset" class="mini-btn" style="flex:0 0 auto">Reset</button>`;
  body.appendChild(calRow);

  const canvas = document.createElement('canvas'); canvas.id = 'heatCanvas'; canvas.width = 720; canvas.height = 720;
  body.appendChild(canvas);
  const info = document.createElement('div'); info.className = 'note'; info.id = 'heatInfo';
  info.textContent = 'Click a cluster to see who owns it. Use the Align sliders so clusters line up with the map.';
  body.appendChild(info);

  const syncSliders = () => { $('calX').value = cal.dx; $('calY').value = cal.dy; $('calSpan').value = cal.span; $('calFlip').checked = cal.flipY; };
  const redraw = () => drawHeat(canvas, cells, { mapImg: bg === 'map' ? mapImg : null, cal: effCal(mapKey, cal) });
  async function load(ownerId) {
    info.textContent = 'Loading…';
    const res = await api.heatmap({ map: mapKey, ...(ownerId ? { ownerId } : {}) });
    if (!res.ok) { $('heatCount').textContent = res.message; info.textContent = res.message; return; }
    cells = res.cells; curBin = res.bin || 7000;
    $('heatCount').textContent = `${res.count} buildings · ${res.cellCount} clusters`;
    info.textContent = 'Click a cluster to see who owns it.';
    redraw();
  }

  const top = await api.topBuilders();
  if (top.ok && top.table) {
    const sel = $('heatOwner');
    top.table.rows.forEach((r) => { const o = document.createElement('option'); o.value = r.owner_id; o.textContent = `${r.name && r.name !== 'void' ? r.name : 'Unknown'} (${r.pieces})`; sel.appendChild(o); });
    sel.onchange = () => load(sel.value);
  }
  $('heatMap').onchange = async (e) => { mapKey = e.target.value; cal = loadCal(mapKey); mapImg = await curImg(); syncSliders(); await load($('heatOwner').value); };
  $('heatBg').onchange = (e) => { bg = e.target.value; $('calRow').style.display = bg === 'map' ? 'flex' : 'none'; redraw(); };
  $('heatReload').onclick = () => load($('heatOwner').value);
  const onCal = () => { cal = { dx: +$('calX').value, dy: +$('calY').value, span: +$('calSpan').value, flipY: $('calFlip').checked }; saveCal(mapKey, cal); redraw(); };
  $('calSpan').oninput = onCal; $('calX').oninput = onCal; $('calY').oninput = onCal; $('calFlip').onchange = onCal;
  $('calReset').onclick = () => { cal = { dx: 0, dy: 0, span: MAP_DEFS[mapKey].span, flipY: false }; saveCal(mapKey, cal); syncSliders(); redraw(); };

  // click -> owner: convert click to absolute world coords (incl. Siptah offset)
  // and ask the server who owns the buildings around that spot.
  canvas.onclick = async (ev) => {
    if (!canvas._toWorld) return;
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const w = canvas._toWorld(px, py);
    info.textContent = 'Looking up owner…';
    const res = await api.ownerAt({ x: w.x, y: w.y, radius: Math.max(4000, curBin) });
    if (res && res.ok && res.owner != null) {
      info.innerHTML = `Owner: <b style="color:var(--yellow)">${esc(res.owner)}</b> — ${res.pieces} building piece(s) nearby · owner_id ${res.ownerId}`;
    } else if (res && res.ok && res.ownerId != null) {
      info.innerHTML = `Owner: <b style="color:var(--yellow)">owner ${res.ownerId}</b> — ${res.pieces} piece(s) nearby (no player/clan on record — likely removed)`;
    } else {
      info.textContent = 'No buildings near that spot — click directly on a red cluster.';
    }
  };

  syncSliders();
  $('calRow').style.display = bg === 'map' ? 'flex' : 'none';
  await load('');
}

// cells: [{x, y, count}] in world units. Renders density (count -> size/heat)
// and stores forward (world->pixel) + inverse (pixel->world) transforms on the
// canvas so the click handler can map a click back to world coordinates.
function drawHeat(canvas, cells, opts = {}) {
  const ctx = canvas.getContext('2d'); const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, W, H);
  let toPix, toWorld;
  if (opts.mapImg) {
    ctx.drawImage(opts.mapImg, 0, 0, W, H);
    ctx.fillStyle = 'rgba(5,7,13,0.42)'; ctx.fillRect(0, 0, W, H); // darken so heat reads
    const { cx, cy, span, flipY } = opts.cal;
    toPix = (p) => ({
      x: (0.5 + (p.x - cx) / span) * W,
      y: (flipY ? (0.5 - (p.y - cy) / span) : (0.5 + (p.y - cy) / span)) * H,
    });
    toWorld = (px, py) => ({
      x: cx + (px / W - 0.5) * span,
      y: cy + (flipY ? (0.5 - py / H) : (py / H - 0.5)) * span,
    });
  } else {
    const pad = 18;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of cells) {
      if (Math.abs(p.x) > 600000 || Math.abs(p.y) > 600000) continue;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) { minX = -400000; maxX = 400000; minY = -400000; maxY = 400000; }
    const span = Math.max(maxX - minX || 1, maxY - minY || 1);
    toPix = (p) => ({ x: pad + ((p.x - minX) / span) * (W - 2 * pad), y: H - pad - ((p.y - minY) / span) * (H - 2 * pad) });
    toWorld = (px, py) => ({ x: minX + ((px - pad) / (W - 2 * pad)) * span, y: minY + ((H - pad - py) / (H - 2 * pad)) * span });
  }
  canvas._toPix = toPix; canvas._toWorld = toWorld;
  if (!cells.length) return;
  const maxCount = cells.reduce((m, c) => Math.max(m, c.count), 1);
  ctx.globalCompositeOperation = 'lighter';
  for (const p of cells) {
    const q = toPix(p);
    if (q.x < -20 || q.x > W + 20 || q.y < -20 || q.y > H + 20) continue;
    const t = Math.sqrt(p.count / maxCount);        // density 0..1 (sqrt = softer)
    const r = 5 + t * 16;                            // denser cluster = bigger glow
    const a = 0.30 + t * 0.45;
    const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
    g.addColorStop(0, `rgba(255,${Math.round(170 - t * 150)},40,${a})`); // yellow->red by density
    g.addColorStop(1, 'rgba(255,80,40,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---------- server modal (add / edit) ----------
function openServerModal(id) {
  editingServerId = id || null;
  const s = id ? servers.find((x) => x.id === id) : null;
  $('serverModalTitle').textContent = s ? `Edit: ${s.name}` : 'Add server';
  $('cfgName').value = s ? s.name : '';
  $('cfgHost').value = s ? s.host : '';
  $('cfgPort').value = s ? s.port : 25575;
  $('cfgPass').value = s ? s.password : '';
  $('cfgAdmin').value = s ? s.adminCharName : '';
  const cc = (s && s.consoleCommands) || {};
  $('cfgKill').value = cc.kill || '';
  $('cfgTp').value = cc.teleportSelf || '';
  $('cfgFreeze').value = cc.freeze || '';
  $('cfgUnfreeze').value = cc.unfreeze || '';
  $('deleteServerBtn').classList.toggle('hidden', !s);
  $('testResult').textContent = '';
  $('serverModal').classList.remove('hidden');
}
function readServerForm() {
  return {
    name: $('cfgName').value.trim() || 'Unnamed Server',
    host: $('cfgHost').value.trim(),
    port: parseInt($('cfgPort').value, 10) || 25575,
    password: $('cfgPass').value,
    adminCharName: $('cfgAdmin').value.trim(),
    consoleCommands: {
      kill: $('cfgKill').value.trim() || 'Suicide',
      teleportSelf: $('cfgTp').value.trim() || 'TeleportPlayer',
      freeze: $('cfgFreeze').value.trim(),
      unfreeze: $('cfgUnfreeze').value.trim(),
    },
  };
}
$('addServerBtn').onclick = () => openServerModal(null);
$('emptyAddBtn').onclick = () => openServerModal(null);
$('editServerBtn').onclick = () => { if (activeServer()) openServerModal(activeId); };
$('closeServer').onclick = () => $('serverModal').classList.add('hidden');
$('cancelServer').onclick = () => $('serverModal').classList.add('hidden');
$('testBtn').onclick = async () => {
  const el = $('testResult'); el.className = 'test-result'; el.textContent = 'Testing…';
  const r = await api.testServer(readServerForm());
  el.className = 'test-result ' + (r.ok ? 'ok' : 'err');
  el.textContent = r.message;
};
$('saveServer').onclick = async () => {
  const form = readServerForm();
  let cfg;
  if (editingServerId) cfg = await api.updateServer(editingServerId, form);
  else { const r = await api.addServer(form); cfg = r.cfg; }
  applyCfg(cfg);
  $('serverModal').classList.add('hidden');
  selected = null; updateSelected();
  await refreshPlayers();
};
$('deleteServerBtn').onclick = async () => {
  if (!editingServerId) return;
  const s = servers.find((x) => x.id === editingServerId);
  if (!(await api.confirm({ title: 'Delete server', message: `Remove "${s ? s.name : ''}" from your server list?` }))) return;
  const cfg = await api.deleteServer(editingServerId);
  applyCfg(cfg);
  $('serverModal').classList.add('hidden');
  selected = null; updateSelected();
  await refreshPlayers();
};

$('refreshBtn').onclick = refreshPlayers;
$('playerSearch').oninput = renderPlayers;
$('clearOut').onclick = () => { $('outBody').innerHTML = '<div class="hint">Cleared.</div>'; };

// ---------- support box (bottom-right) ----------
const SUPPORT = {
  coffee: 'https://www.paypal.com/ncp/payment/V7CDA8EBKSGB2',  // Buy me a coffee (PayPal)
  discord: 'https://discord.gg/TTDew4G7eR',                    // Support Discord
};
$('coffeeBtn').querySelector('.support-ico').innerHTML = SVG('<path d="M4 8h13v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h2a2 2 0 0 1 0 4h-2"/><path d="M7 2.5v2M10 2.5v2M13 2.5v2"/>');
$('discordBtn').querySelector('.support-ico').innerHTML = SVG('<path d="M4 5h16v11H8l-4 4z"/><circle cx="9.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/>');
$('coffeeBtn').onclick = () => api.openExternal(SUPPORT.coffee);
$('discordBtn').onclick = () => api.openExternal(SUPPORT.discord);

// ---------- theme toggle (light / dark) ----------
const ICON_SUN = SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/>');
const ICON_MOON = SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>');
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) {}
  $('themeToggle').innerHTML = (t === 'light') ? ICON_MOON : ICON_SUN; // show the icon you'll switch TO
}
setTheme((() => { try { return localStorage.getItem('theme') || 'dark'; } catch (e) { return 'dark'; } })());
$('themeToggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

// ---------- "acting as" character indicator ----------
function updateActing() {
  const s = activeServer();
  const name = s && s.adminCharName;
  const dot = $('actingDot'), txt = $('actingText');
  if (!name) { dot.className = 'dot off'; txt.innerHTML = '<span class="acting-label">ACTING AS</span><span class="acting-set">set your character ›</span>'; return; }
  const online = players.some((p) => p.charName.toLowerCase() === name.toLowerCase());
  dot.className = 'dot ' + (online ? 'on' : 'off');
  txt.innerHTML = `<span class="acting-label">ACTING AS</span><span class="acting-name">${esc(name)}</span><span class="acting-status ${online ? 'on' : 'off'}">${online ? 'online' : 'offline'}</span>`;
}
$('actingRow').onclick = () => { if (activeServer()) openServerModal(activeId); };

// Esc closes whichever modal is open (data/heatmap first, then server dialog).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const data = $('dataModal'), server = $('serverModal');
  if (data && !data.classList.contains('hidden')) { data.classList.add('hidden'); e.preventDefault(); }
  else if (server && !server.classList.contains('hidden')) { server.classList.add('hidden'); e.preventDefault(); }
});

// ---------- toast + clipboard ----------
function toast(msg) {
  let t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tmr); t._tmr = setTimeout(() => t.classList.remove('show'), 1700);
}
async function copyText(text, label) {
  if (text == null || text === '') { toast('Nothing to copy'); return; }
  try { await navigator.clipboard.writeText(String(text)); toast(`${label || 'Copied'}: ${text}`); }
  catch (e) { toast('Copy failed'); }
}

// ---------- broadcast composer ----------
function bcPresets() { try { return JSON.parse(localStorage.getItem('bcPresets') || '[]'); } catch (e) { return []; } }
function bcSave(a) { try { localStorage.setItem('bcPresets', JSON.stringify(a.slice(0, 12))); } catch (e) {} }
async function showBroadcast() {
  $('dataTitle').textContent = 'Broadcast Message';
  const body = $('dataBody'); body.innerHTML = '';
  body.appendChild(noteEl('Sends a centered popup to all online players (not a chat line).'));
  const wrap = document.createElement('div'); wrap.className = 'edit-grid';
  wrap.innerHTML = `<label>Message <input id="bcMsg" maxlength="200" placeholder="Server restarting in 5 minutes — log out safely!" /></label>`;
  body.appendChild(wrap);
  const presetRow = document.createElement('div'); presetRow.className = 'bc-presets'; body.appendChild(presetRow);
  function renderPresets() {
    presetRow.innerHTML = '';
    const a = bcPresets();
    if (!a.length) { presetRow.appendChild(noteEl('Save a message as a preset to reuse it.')); return; }
    a.forEach((p, i) => {
      const chip = document.createElement('span'); chip.className = 'bc-chip'; chip.textContent = p;
      chip.onclick = () => { $('bcMsg').value = p; };
      const x = document.createElement('button'); x.className = 'bc-chip-x'; x.textContent = '×'; x.title = 'remove preset';
      x.onclick = (e) => { e.stopPropagation(); const arr = bcPresets(); arr.splice(i, 1); bcSave(arr); renderPresets(); };
      chip.appendChild(x); presetRow.appendChild(chip);
    });
  }
  renderPresets();
  const btns = document.createElement('div'); btns.className = 'modal-actions';
  const send = document.createElement('button'); send.className = 'primary-btn'; send.textContent = 'Send broadcast';
  send.onclick = async () => { const m = $('bcMsg').value.trim(); if (!m) return; $('dataModal').classList.add('hidden'); await run('Broadcast', api.broadcast(m)); };
  const savep = document.createElement('button'); savep.className = 'mini-btn'; savep.style.flex = '0 0 auto'; savep.textContent = 'Save as preset';
  savep.onclick = () => { const m = $('bcMsg').value.trim(); if (!m) return; const a = bcPresets(); if (!a.includes(m)) { a.unshift(m); bcSave(a); renderPresets(); } };
  btns.appendChild(send); btns.appendChild(savep);
  body.appendChild(btns);
  $('dataModal').classList.remove('hidden');
  setTimeout(() => $('bcMsg').focus(), 50);
}

// ---------- RCON console ----------
async function showRconConsole() {
  $('dataTitle').textContent = 'RCON Console';
  const body = $('dataBody'); body.innerHTML = '';
  body.appendChild(noteEl('Power user: sends raw commands to the active server. Anything in the RCON command set works (including destructive ones). Try: help · listplayers · sql SELECT COUNT(*) FROM characters; · ↑/↓ for history.'));
  const out = document.createElement('div'); out.className = 'rcon-out'; out.id = 'rconOut'; body.appendChild(out);
  const bar = document.createElement('div'); bar.className = 'find-bar';
  bar.innerHTML = `<input id="rconIn" placeholder="type a command and press Enter…" spellcheck="false" autocomplete="off" /><button id="rconSend" class="primary-btn">Send</button>`;
  body.appendChild(bar);
  const hist = []; let hi = -1;
  function append(cmd, reply, err) {
    const e = document.createElement('div'); e.className = 'rcon-entry' + (err ? ' err' : '');
    e.innerHTML = `<div class="rcon-cmd">&gt; ${esc(cmd)}</div><pre class="rcon-reply">${esc(reply)}</pre>`;
    out.appendChild(e); out.scrollTop = out.scrollHeight;
  }
  async function send() {
    const cmd = $('rconIn').value.trim(); if (!cmd) return;
    hist.unshift(cmd); hi = -1; $('rconIn').value = '';
    const r = await api.raw(cmd);
    append(cmd, (r && r.ok) ? (r.raw || '(no output)') : ((r && r.message) || 'error'), !(r && r.ok));
  }
  $('rconSend').onclick = send;
  $('rconIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
    else if (e.key === 'ArrowUp') { if (hi < hist.length - 1) { hi++; $('rconIn').value = hist[hi] || ''; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (hi > 0) { hi--; $('rconIn').value = hist[hi] || ''; } else { hi = -1; $('rconIn').value = ''; } e.preventDefault(); }
  });
  $('dataModal').classList.remove('hidden');
  setTimeout(() => $('rconIn').focus(), 50);
}

// ---------- right-click player context menu ----------
function closeCtx() { const m = $('ctxMenu'); if (m) m.remove(); }
function showCtxMenu(ev, p) {
  ev.preventDefault(); closeCtx();
  const m = document.createElement('div'); m.id = 'ctxMenu'; m.className = 'ctx-menu';
  const act = (fn) => async () => { closeCtx(); await selectPlayer(p); fn(); };
  const COPY_ICON = SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  const items = [
    { ico: 'kick', label: 'Kick Player', fn: act(() => ACTIONS.kick()) },
    { ico: 'kill', label: 'Kill Player', fn: act(() => ACTIONS.kill()) },
    { ico: 'teleportTo', label: 'Teleport to', fn: act(() => ACTIONS.teleportTo()) },
    { ico: 'summon', label: 'Summon', fn: act(() => ACTIONS.summon()) },
    { ico: 'viewInventory', label: 'View Inventory', fn: act(() => ACTIONS.viewInventory()) },
    { sep: true },
    { svg: COPY_ICON, color: 'var(--muted)', label: 'Copy SteamID', fn: () => { closeCtx(); copyText(p.platformId, 'SteamID'); } },
    { svg: COPY_ICON, color: 'var(--muted)', label: 'Copy User ID', fn: () => { closeCtx(); copyText(p.userId, 'User ID'); } },
  ];
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); return; }
    const el = document.createElement('div'); el.className = 'ctx-item';
    const svg = it.svg || ICONS[it.ico] || '';
    const col = it.color || ICON_COLORS[it.ico] || 'var(--text-dim)';
    el.innerHTML = `<span class="ctx-ico" style="color:${col}">${svg}</span><span>${esc(it.label)}</span>`;
    el.onclick = it.fn;
    m.appendChild(el);
  });
  document.body.appendChild(m);
  const mw = 186, mh = m.offsetHeight || 240;
  let x = ev.clientX, y = ev.clientY;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 6;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 6;
  m.style.left = x + 'px'; m.style.top = y + 'px';
}
document.addEventListener('click', closeCtx);
window.addEventListener('blur', closeCtx);

// ---------- live mini-map (bottom-right, 60s refresh) ----------
let _miniKey = 'exiled';
let _miniPlayers = [];
const _miniImgs = {};
let _miniStarted = false;
const miniImg = async (k) => { if (!(k in _miniImgs)) _miniImgs[k] = await loadImage(MAP_DEFS[k].img); return _miniImgs[k]; };
const miniInRegion = (p) => (_miniKey === 'siptah' ? p.x > 800000 : p.x <= 800000);
async function drawMini() {
  const canvas = $('miniCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d'); const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, W, H);
  const img = await miniImg(_miniKey);
  if (img) { ctx.drawImage(img, 0, 0, W, H); ctx.fillStyle = 'rgba(5,7,13,0.32)'; ctx.fillRect(0, 0, W, H); }
  const cal = effCal(_miniKey, loadCal(_miniKey));
  const toPix = (p) => ({ x: (0.5 + (p.x - cal.cx) / cal.span) * W, y: (cal.flipY ? (0.5 - (p.y - cal.cy) / cal.span) : (0.5 + (p.y - cal.cy) / cal.span)) * H });
  const here = _miniPlayers.filter(miniInRegion);
  canvas._dots = [];
  here.forEach((p) => {
    const q = toPix(p); if (q.x < -6 || q.x > W + 6 || q.y < -6 || q.y > H + 6) return;
    canvas._dots.push({ x: q.x, y: q.y, name: p.name });
    ctx.beginPath(); ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80'; ctx.shadowColor = '#4ade80'; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
  });
  if ($('miniOnline')) $('miniOnline').textContent = `${here.length} here · ${_miniPlayers.length} on`;
}
async function refreshMiniMap() {
  const mm = $('miniMap'); if (!mm) return;
  if (!activeServer()) { mm.classList.add('hidden'); return; }
  mm.classList.remove('hidden');
  try { const res = await api.livePositions(); if (res && res.ok) _miniPlayers = res.players || []; } catch (e) {}
  drawMini();
}
const MINI_SIZES = { s: 230, m: 330, l: 452 };
function applyMiniSize() {
  const sz = localStorage.getItem('miniSize') || 's';
  const mm = $('miniMap'); if (!mm) return;
  mm.classList.remove('size-s', 'size-m', 'size-l'); mm.classList.add('size-' + sz);
  const c = $('miniCanvas'); const px = MINI_SIZES[sz] || 230; c.width = px; c.height = px;
  drawMini();
}
function startMiniMap() {
  refreshMiniMap();
  if (_miniStarted) return;
  _miniStarted = true;
  applyMiniSize();
  if (localStorage.getItem('miniCollapsed') === '1') $('miniMap').classList.add('collapsed');
  $('miniCollapse').textContent = $('miniMap').classList.contains('collapsed') ? '▴' : '▾';
  $('miniSize').onclick = () => {
    const order = ['s', 'm', 'l'];
    const next = order[(order.indexOf(localStorage.getItem('miniSize') || 's') + 1) % order.length];
    localStorage.setItem('miniSize', next); applyMiniSize();
  };
  $('miniMapSel').onchange = (e) => { _miniKey = e.target.value; drawMini(); };
  $('miniCollapse').onclick = () => {
    const c = $('miniMap').classList.toggle('collapsed');
    localStorage.setItem('miniCollapsed', c ? '1' : '0');
    $('miniCollapse').textContent = c ? '▴' : '▾';
  };
  const canvas = $('miniCanvas'), tip = $('miniTip');
  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    let best = null, bd = 13 * 13;
    (canvas._dots || []).forEach((d) => { const dd = (d.x - px) * (d.x - px) + (d.y - py) * (d.y - py); if (dd < bd) { bd = dd; best = d; } });
    if (best) { tip.textContent = best.name; tip.style.left = Math.min(rect.width - 60, ev.clientX - rect.left + 8) + 'px'; tip.style.top = (ev.clientY - rect.top - 8) + 'px'; tip.classList.remove('hidden'); }
    else tip.classList.add('hidden');
  };
  canvas.onmouseleave = () => tip.classList.add('hidden');
  setInterval(refreshMiniMap, 60000); // once per minute
}

// ---------- boot ----------
(async function init() {
  const cfg = await api.getServers();
  applyCfg(cfg);
  if (!servers.length) {
    log({ ok: false, title: 'Welcome', message: 'Click "+ Add Server" (top right) to add your Conan Exiles server.' });
  } else {
    await refreshPlayers();
  }
  startMiniMap();
})();
})();
