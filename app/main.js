'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { RconClient } = require('./src/rcon');
const actions = require('./src/actions');
const store = require('./src/config');

// ---- item metadata + icons (for View Inventory) ---------------------------
// item DB (template_id -> {n,c,w,i}) is bundled functional metadata. Item icons
// are bundled too (renderer/assets/items/<name>.webp, 64px) so View Inventory
// works fully offline — no network fetch. A user can still override any icon by
// dropping a file in their userData/icons folder.
let _itemDb = null;
function itemDb() {
  if (_itemDb) return _itemDb;
  let base = {};
  try { base = JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer', 'assets', 'items.json'), 'utf8')); } catch (e) {}
  // Optional user-supplied extension (e.g. extracted from their own game install:
  // building pieces, mod items, fixes). Merged over the built-in set.
  try {
    const extra = path.join(app.getPath('userData'), 'items-extra.json');
    if (fs.existsSync(extra)) { const ex = JSON.parse(fs.readFileSync(extra, 'utf8')); for (const k in ex) base[k] = ex[k]; }
  } catch (e) {}
  _itemDb = base;
  return _itemDb;
}
function userIconDir() { return path.join(app.getPath('userData'), 'icons'); }
const ITEM_ICON_DIR = path.join(__dirname, 'renderer', 'assets', 'items'); // bundled 64px webp icons
const ICON_HOST = 'https://ool.iota-plus.com'; // redirect base for fetchBuf (update check); icons no longer fetched
function fetchBuf(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'PlaT-RCON-Admin' }, timeout: 9000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : ICON_HOST + res.headers.location;
        return resolve(fetchBuf(next, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
function mimeFor(file) {
  if (/\.webp$/i.test(file)) return 'image/webp';
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg';
  return 'image/png';
}

let win;
let mapWin = null;              // popped-out live map window (at most one)
let cfg = null;                 // { servers, activeServerId }
const conns = new Map();        // serverId -> RconClient

function userDataDir() { return app.getPath('userData'); }
function activeServer() { return (cfg.servers || []).find((s) => s.id === cfg.activeServerId) || null; }

// Only allow one running instance (prevents shared-cache collisions).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#070a12',
    title: "PlaT's Gaming — CE Enhanced RCON Admin",
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  cfg = store.load(userDataDir());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const c of conns.values()) c.close();
  if (process.platform !== 'darwin') app.quit();
});

// ---- connection management (one socket per server) ------------------------

async function connectFor(server) {
  if (!server) throw new Error('No server selected.');
  if (!server.host || !server.password) throw new Error('This server is missing its IP or RCON password. Edit it to add them.');
  let c = conns.get(server.id);
  if (c && c.authed) return c;
  if (c) c.close();
  c = new RconClient({ host: server.host, port: server.port, password: server.password, timeout: server.timeout || 8000 });
  await c.connect();
  conns.set(server.id, c);
  return c;
}

async function ensureActive() {
  const s = activeServer();
  if (!s) throw new Error('Add a server to get started.');
  const client = await connectFor(s);
  return { client, server: s };
}

// Wrap an action so errors become a normalized failure result.
function guard(fn) {
  return async (event, ...args) => {
    try {
      const { client, server } = await ensureActive();
      return await fn(client, server, ...args);
    } catch (e) {
      return { ok: false, title: 'Error', message: e.message || String(e) };
    }
  };
}

// ---- IPC: server management ----------------------------------------------

ipcMain.handle('servers:get', () => cfg);

ipcMain.handle('servers:add', (e, partial) => {
  const s = store.newServer(partial || {});
  cfg.servers.push(s);
  cfg.activeServerId = s.id;
  cfg = store.save(userDataDir(), cfg);
  return { cfg, activeId: s.id };
});

ipcMain.handle('servers:update', (e, id, partial) => {
  const idx = cfg.servers.findIndex((s) => s.id === id);
  if (idx >= 0) {
    cfg.servers[idx] = store.newServer({ ...cfg.servers[idx], ...partial, id });
    const c = conns.get(id);
    if (c) { c.close(); conns.delete(id); } // creds may have changed -> reconnect on next use
    cfg = store.save(userDataDir(), cfg);
  }
  return cfg;
});

ipcMain.handle('servers:delete', (e, id) => {
  const c = conns.get(id);
  if (c) { c.close(); conns.delete(id); }
  cfg.servers = cfg.servers.filter((s) => s.id !== id);
  if (cfg.activeServerId === id) cfg.activeServerId = cfg.servers[0] ? cfg.servers[0].id : null;
  cfg = store.save(userDataDir(), cfg);
  return cfg;
});

ipcMain.handle('servers:setActive', (e, id) => {
  if (cfg.servers.find((s) => s.id === id)) { cfg.activeServerId = id; cfg = store.save(userDataDir(), cfg); }
  return cfg;
});

// Test arbitrary credentials WITHOUT saving them (used by the Add/Edit dialog).
ipcMain.handle('servers:test', async (e, server) => {
  let c = null;
  try {
    c = new RconClient({ host: server.host, port: server.port || 25575, password: server.password, timeout: server.timeout || 8000 });
    await c.connect();
    const players = await actions.listPlayers(c);
    return { ok: true, message: `Connected · ${players.length} player(s) online.` };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  } finally {
    if (c) c.close();
  }
});

// ---- IPC: data + actions --------------------------------------------------

ipcMain.handle('players:list', guard(async (client) => ({ ok: true, players: await actions.listPlayers(client) })));

ipcMain.handle('player:resolve', guard(async (client, server, player) => {
  const db = await actions.resolveDbCharacter(client, { userId: player.userId, charName: player.charName });
  return { ok: true, target: { ...player, dbId: db ? db.dbId : null, dbLevel: db ? db.level : null } };
}));

const A = (name, fn) => ipcMain.handle(name, guard(fn));
A('act:kick', (c, s, t, msg) => actions.kickPlayer(c, s, t, msg));
A('act:kill', (c, s, t) => actions.killPlayer(c, s, t));
A('act:freeze', (c, s, t, on) => actions.freezePlayer(c, s, t, on));
A('act:teleportTo', (c, s, t) => actions.teleportToPlayer(c, s, t));
A('act:summon', (c, s, t) => actions.summonPlayer(c, s, t));
A('act:sendHome', (c, s, t, opts) => actions.sendHome(c, s, t, opts));
A('act:homeOptions', (c, s, t) => actions.homeOptions(c, s, t));
A('act:viewCharacter', (c, s, t) => actions.viewCharacter(c, s, t));
A('act:editCharacter', (c, s, t, fields) => actions.editCharacter(c, s, t, fields));
A('act:setLevel', (c, s, t, level) => actions.setLevel(c, s, t, level));
A('act:deleteCharacter', (c, s, t) => actions.deleteCharacter(c, s, t));
A('act:removeBuildings', (c, s, t) => actions.removeBuildings(c, s, t));
A('act:viewInventory', (c, s, t) => actions.viewInventory(c, s, t));
A('act:heatmap', (c, s, opts) => actions.buildingHeatmap(c, s, opts));
A('act:ownerAt', (c, s, at) => actions.buildingOwnerAt(c, s, at));
A('act:dashboard', (c, s) => actions.serverDashboard(c, s));
A('act:listBans', (c, s) => actions.listBans(c, s));
A('act:ban', (c, s, opts) => actions.banPlayer(c, s, opts));
A('act:unban', (c, s, id) => actions.unbanPlayer(c, s, id));
A('act:whitelist', (c, s, id, on) => actions.whitelistPlayer(c, s, id, on));
A('act:findChars', (c, s, q) => actions.findCharacters(c, s, q));
A('act:buildingReport', (c, s) => actions.buildingReport(c, s));
A('act:abandonedBases', (c, s, opts) => actions.abandonedBases(c, s, opts));
A('act:destroyOwner', (c, s, ownerId) => actions.destroyOwnerBuildings(c, s, ownerId));
A('act:raidLog', (c, s, opts) => actions.raidLog(c, s, opts));
A('act:clanList', (c, s) => actions.clanList(c, s));
A('act:clanMembers', (c, s, id) => actions.clanMembers(c, s, id));
A('act:renameGuild', (c, s, id, name) => actions.renameGuild(c, s, id, name));
A('act:setGuildOwner', (c, s, id, charId) => actions.setGuildOwner(c, s, id, charId));
A('act:disbandGuild', (c, s, id) => actions.disbandGuild(c, s, id));
A('act:livePositions', (c, s) => actions.livePlayerPositions(c, s));
A('act:raw', (c, s, cmd) => actions.rawCommand(c, s, cmd));
A('act:broadcast', (c, s, msg) => actions.broadcastMessage(c, s, msg));
A('act:topBuilders', (c, s) => actions.topBuilders(c, s));

ipcMain.handle('open:external', (e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
});

// ---- lightweight update check ---------------------------------------------
// Tries the GitHub Releases API first (works with NO auth token once the repo is
// public — publishing a Release IS the update notification), then falls back to a
// small manifest on platsgaming.com. Both are token-free; fails silently when
// offline / private / absent. GitHub needs a User-Agent (fetchBuf sets one).
//   GitHub: latest release tag_name + the Setup.exe asset's download URL.
//   Manifest: { "version": "1.3.14", "url": "https://...", "notes": "..." }
const GH_RELEASES_API = 'https://api.github.com/repos/PlaTlol/PlaTs-Gaming-CE-Enhanced-RCON-Admin/releases/latest';
const UPDATE_MANIFEST = 'https://platsgaming.com/rcon-admin/latest.json';
const DOWNLOAD_PAGE = 'https://platsgaming.com';
function isNewerVersion(remote, current) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const r = norm(remote); const c = norm(current);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const a = r[i] || 0; const b = c[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}
async function fetchLatestRelease() {
  // 1) GitHub Releases API (public repo, no token)
  try {
    const d = JSON.parse((await fetchBuf(GH_RELEASES_API)).toString('utf8'));
    if (d && d.tag_name && !d.draft) {
      const asset = Array.isArray(d.assets) ? d.assets.find((a) => /setup.*\.exe$/i.test(a.name)) : null;
      return { version: d.tag_name, url: (asset && asset.browser_download_url) || d.html_url || DOWNLOAD_PAGE, notes: d.body || '', source: 'github' };
    }
  } catch (e) { /* private / offline / rate-limited -> fall back */ }
  // 2) platsgaming.com manifest
  try {
    const d = JSON.parse((await fetchBuf(UPDATE_MANIFEST)).toString('utf8'));
    if (d && d.version) {
      const url = (typeof d.url === 'string' && /^https:\/\//i.test(d.url)) ? d.url : DOWNLOAD_PAGE;
      return { version: d.version, url, notes: typeof d.notes === 'string' ? d.notes : '', source: 'platsgaming' };
    }
  } catch (e) { /* no manifest -> no update */ }
  return null;
}
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  try {
    const latest = await fetchLatestRelease();
    if (latest && isNewerVersion(latest.version, current)) {
      return { ok: true, updateAvailable: true, latest: String(latest.version).replace(/^v/i, ''), current, url: latest.url, notes: latest.notes, source: latest.source };
    }
    return { ok: true, updateAvailable: false, current };
  } catch (err) {
    return { ok: false, updateAvailable: false, current, message: err.message };
  }
});

ipcMain.handle('map:popout', () => {
  if (mapWin && !mapWin.isDestroyed()) { mapWin.focus(); return { ok: true }; }
  mapWin = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 300,
    minHeight: 320,
    backgroundColor: '#070a12',
    title: 'Live Map',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mapWin.removeMenu();
  mapWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { search: 'popout=map' });
  mapWin.on('closed', () => { mapWin = null; });
  return { ok: true };
});

ipcMain.handle('item:db', () => itemDb());

ipcMain.handle('item:icon', (e, file) => {
  if (!file || typeof file !== 'string' || file.includes('..')) return null;
  // Use the basename only (icons are keyed by filename, whether the DB stores
  // "icon_x.png" or an absolute "/static/icons/icon_x.png").
  const name = String(file).replace(/^.*\//, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!name) return null;
  const baseName = name.replace(/\.[a-z0-9]+$/i, '');
  try {
    // 1) user override — a file they dropped in userData/icons
    const local = path.join(userIconDir(), name);
    if (fs.existsSync(local)) {
      const buf = fs.readFileSync(local);
      if (buf.length) return `data:${mimeFor(name)};base64,${buf.toString('base64')}`;
    }
    // 2) bundled icon shipped with the app (64px webp) — no network
    const bundled = path.join(ITEM_ICON_DIR, baseName + '.webp');
    if (fs.existsSync(bundled)) {
      const buf = fs.readFileSync(bundled);
      if (buf.length) return `data:image/webp;base64,${buf.toString('base64')}`;
    }
    return null;
  } catch (err) {
    return null;
  }
});

ipcMain.handle('confirm', async (e, { title, message }) => {
  const res = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel', 'Confirm'], defaultId: 0, cancelId: 0,
    title: title || 'Confirm', message: message || 'Are you sure?',
  });
  return res.response === 1;
});
