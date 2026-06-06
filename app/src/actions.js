'use strict';
const { parseSqlTable, parseListPlayers, sqlEscape } = require('./sqlparse');

// Every function here returns a normalized result:
//   { ok: bool, title: string, message?: string, table?: {columns,rows}, raw?: string }
// `rcon` is a connected RconClient. `cfg` is the saved config.

const toInt = (v) => {
  const n = Number(String(v).replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Shown after direct game.db edits: the live server keeps world state in memory,
// so sql writes aren't loaded until the server reloads the data (on restart, or
// for a character on their next relog), and a running server can overwrite them
// on its next autosave. Native/live commands don't need this.
const RESTART_NOTE = '⚠ Restart the server to apply. This edits game.db directly — the running server keeps this data in memory, so it won\'t take effect until the server reloads it (a restart, or a relog for a character) and may overwrite it on its next autosave. Best: make the edit, then restart soon after (ideally while the affected player is offline).';

// ---- shared lookups -------------------------------------------------------

async function listPlayers(rcon) {
  const raw = await rcon.command('listplayers');
  return parseListPlayers(raw);
}

function mapCharRow(r) {
  return { dbId: toInt(r.id), charName: r.char_name, level: r.level, isAlive: r.isAlive, guild: r.guild };
}

// Resolve an online player (from listplayers) to their DB character row.
// The reliable key is: listplayers User ID == account.user, and
// characters.playerId == account.id (a small integer, NOT the "A-..." string).
// So we join through `account`. Falls back to a char_name match.
async function resolveDbCharacter(rcon, { userId, charName }) {
  if (userId) {
    const raw = await rcon.command(
      `sql SELECT c.id AS id, c.char_name AS char_name, c.level AS level, c.isAlive AS isAlive, c.guild AS guild ` +
      `FROM characters c JOIN account a ON a.id = c.playerId WHERE a.user='${sqlEscape(userId)}' LIMIT 1;`
    );
    const { rows } = parseSqlTable(raw);
    if (rows.length) return mapCharRow(rows[0]);
  }
  if (charName) {
    const raw = await rcon.command(
      `sql SELECT id,char_name,level,isAlive,guild FROM characters WHERE char_name='${sqlEscape(charName)}' LIMIT 1;`
    );
    const { rows } = parseSqlTable(raw);
    if (rows.length) return mapCharRow(rows[0]);
  }
  return null;
}

async function getCoords(rcon, dbId) {
  const raw = await rcon.command(
    `sql SELECT x,y,z FROM actor_position WHERE id=${toInt(dbId)} LIMIT 1;`
  );
  const { rows } = parseSqlTable(raw);
  if (!rows.length) return null;
  const r = rows[0];
  return { x: parseFloat(r.x), y: parseFloat(r.y), z: parseFloat(r.z) };
}

// Find the configured admin among online players and resolve coords.
async function getAdmin(rcon, cfg) {
  if (!cfg.adminCharName) throw new Error('No admin character name set in Settings.');
  const players = await listPlayers(rcon);
  const me = players.find((p) => p.charName.toLowerCase() === cfg.adminCharName.toLowerCase());
  if (!me) throw new Error(`Admin character "${cfg.adminCharName}" is not online. Log in first (teleport/summon run in your character's context).`);
  const db = await resolveDbCharacter(rcon, { userId: me.userId, charName: me.charName });
  if (!db) throw new Error('Admin character found online but not in the database yet.');
  const coords = await getCoords(rcon, db.dbId);
  return { ...me, dbId: db.dbId, coords };
}

async function con(rcon, idx, command) {
  return rcon.command(`con ${idx} ${command}`);
}

// ---- PUNISHMENTS ----------------------------------------------------------

async function kickPlayer(rcon, cfg, target, message) {
  const msg = message || 'Kicked by admin';
  const raw = await rcon.command(`kickplayer userid ${target.userId} ${msg}`);
  return { ok: true, title: 'Kick Player', message: `Kicked ${target.charName}.`, raw };
}

async function killPlayer(rcon, cfg, target) {
  const cmd = (cfg.consoleCommands && cfg.consoleCommands.kill) || 'Suicide';
  const raw = await con(rcon, target.idx, cmd);
  return { ok: true, title: 'Kill Player', message: `Sent "${cmd}" to ${target.charName}.`, raw };
}

async function freezePlayer(rcon, cfg, target, freeze) {
  const key = freeze ? 'freeze' : 'unfreeze';
  const cmd = cfg.consoleCommands && cfg.consoleCommands[key];
  if (!cmd) {
    return {
      ok: false,
      title: 'Un/Freeze Player',
      message: 'No native vanilla freeze command exists. Set a console command for "freeze"/"unfreeze" in Settings → Advanced if your server supports one.',
    };
  }
  const raw = await con(rcon, target.idx, cmd);
  return { ok: true, title: 'Un/Freeze Player', message: `Sent "${cmd}" to ${target.charName}.`, raw };
}

// ---- INTERACTIONS ---------------------------------------------------------

// `TeleportToPlayer <name>` resolves the LIVE player entity (not a stale DB
// coordinate) and performs the Exiled Lands <-> Siptah map transition that the
// coordinate-based `TeleportPlayer x y z` can't. Run in a player's context via
// `con`, it moves THAT player to the named target — so the same command powers
// both "teleport me to them" (run as admin) and "summon them to me" (run as the
// target). Verified live: an admin on Exiled Lands teleported onto a player on
// Siptah. Confirmed working 2026-06-04.
async function teleportToPlayer(rcon, cfg, target) {
  if (!target.charName) throw new Error('That player has no character name to teleport to yet.');
  const admin = await getAdmin(rcon, cfg);
  const raw = await con(rcon, admin.idx, `TeleportToPlayer ${target.charName}`);
  return { ok: true, title: 'Teleport to Player', message: `Teleported you (${admin.charName}) to ${target.charName}.`, raw };
}

async function summonPlayer(rcon, cfg, target) {
  const admin = await getAdmin(rcon, cfg);
  if (!admin.charName) throw new Error('Your admin character name is not set.');
  // Run TeleportToPlayer in the TARGET's context so they come to the admin.
  const raw = await con(rcon, target.idx, `TeleportToPlayer ${admin.charName}`);
  return { ok: true, title: 'Summon Player', message: `Summoned ${target.charName} to you (${admin.charName}).`, raw };
}

// Send player to a bed/bedroll they own (reliable, schema-verified).
async function sendHome(rcon, cfg, target) {
  const raw0 = await rcon.command(
    `sql SELECT ap.x AS x, ap.y AS y, ap.z AS z FROM actor_position ap ` +
    `JOIN buildings b ON b.object_id=ap.id ` +
    `WHERE b.owner_id=${toInt(target.dbId)} AND (ap.class LIKE '%Bedroll%' OR ap.class LIKE '%Bed_%' OR ap.class LIKE '%_Bed%') LIMIT 1;`
  );
  const { rows } = parseSqlTable(raw0);
  if (!rows.length) {
    return { ok: false, title: 'Send Home', message: `${target.charName} has no bed/bedroll on the server, so there is no home to send them to.` };
  }
  const r = rows[0];
  const cmd = (cfg.consoleCommands && cfg.consoleCommands.teleportSelf) || 'TeleportPlayer';
  const raw = await con(rcon, target.idx, `${cmd} ${parseFloat(r.x)} ${parseFloat(r.y)} ${parseFloat(r.z)}`);
  return { ok: true, title: 'Send Home', message: `Sent ${target.charName} to their bed.`, raw };
}

// ---- TOOLS ----------------------------------------------------------------

async function viewCharacter(rcon, cfg, target) {
  const id = toInt(target.dbId);
  const charRaw = await rcon.command(
    `sql SELECT id,char_name,level,rank,isAlive,killerName,lastTimeOnline FROM characters WHERE id=${id} LIMIT 1;`
  );
  const propsRaw = await rcon.command(
    `sql SELECT name FROM properties WHERE object_id=${id} AND (` +
    `name LIKE '%ExperiencePoints%' OR name LIKE '%AttributePoints%' OR name LIKE '%Favors%') LIMIT 20;`
  );
  return {
    ok: true,
    title: `Character: ${target.charName}`,
    table: parseSqlTable(charRaw),
    extra: parseSqlTable(propsRaw),
    raw: charRaw,
  };
}

async function editCharacter(rcon, cfg, target, fields) {
  const id = toInt(target.dbId);
  const sets = [];
  if (fields.char_name != null && fields.char_name !== '') sets.push(`char_name='${sqlEscape(fields.char_name)}'`);
  if (fields.level != null && fields.level !== '') sets.push(`level=${toInt(fields.level)}`);
  if (fields.isAlive != null && fields.isAlive !== '') sets.push(`isAlive=${toInt(fields.isAlive) ? 1 : 0}`);
  if (!sets.length) return { ok: false, title: 'Edit Character', message: 'Nothing to change.' };
  const raw = await rcon.command(`sql UPDATE characters SET ${sets.join(', ')} WHERE id=${id};`);
  return { ok: true, title: 'Edit Character', message: `Updated ${target.charName}.`, note: RESTART_NOTE, raw };
}

async function deleteCharacter(rcon, cfg, target) {
  const id = toInt(target.dbId);
  const tables = [
    ['characters', 'id'],
    ['actor_position', 'id'],
    ['character_stats', 'char_id'],
    ['character_buffs', 'char_id'],
    ['item_inventory', 'owner_id'],
    ['item_properties', 'owner_id'],
    ['properties', 'object_id'],
  ];
  const results = [];
  for (const [t, col] of tables) {
    const raw = await rcon.command(`sql DELETE FROM ${t} WHERE ${col}=${id};`);
    results.push(`${t}: ${String(raw).trim()}`);
  }
  return { ok: true, title: 'Delete Character', message: `Deleted ${target.charName} (${id}) and related rows.`, note: RESTART_NOTE, raw: results.join('\n') };
}

async function removeBuildings(rcon, cfg, target) {
  const id = toInt(target.dbId);
  const countRaw = await rcon.command(`sql SELECT COUNT(*) AS pieces FROM buildings WHERE owner_id=${id};`);
  const { rows } = parseSqlTable(countRaw);
  const pieces = rows.length ? rows[0].pieces : '0';
  const raw = await rcon.command(`buildingquery destroy ${id}`);
  return { ok: true, title: 'Remove Buildings', message: `Destroyed buildings for ${target.charName} (~${pieces} pieces).`, raw };
}

async function clearCooldowns(rcon, cfg, target) {
  const id = toInt(target.dbId);
  const raw = await rcon.command(`sql DELETE FROM character_buffs WHERE char_id=${id};`);
  return { ok: true, title: 'Clear All Cooldowns', message: `Cleared active buffs/cooldowns for ${target.charName}.`, note: RESTART_NOTE, raw };
}

async function viewFeats(rcon, cfg, target) {
  const id = toInt(target.dbId);
  // Vanilla stores learned recipes as an opaque blob, so we surface the
  // progression-related properties we CAN read meaningfully.
  const raw = await rcon.command(
    `sql SELECT name, LENGTH(value) AS bytes FROM properties WHERE object_id=${id} AND (` +
    `name LIKE '%Feat%' OR name LIKE '%Progression%' OR name LIKE '%Attribute%' OR name LIKE '%Favors%' OR name LIKE '%Religion%');`
  );
  return {
    ok: true,
    title: `Feats / Progression: ${target.charName}`,
    table: parseSqlTable(raw),
    note: 'Vanilla stores the learned-recipe list as a binary blob, so this shows progression properties and their sizes rather than a decoded recipe list.',
    raw,
  };
}

async function viewQuestFlags(rcon, cfg, target) {
  const id = toInt(target.dbId);
  const raw = await rcon.command(
    `sql SELECT name, LENGTH(value) AS bytes FROM properties WHERE object_id=${id} AND name LIKE '%Quest%';`
  );
  return {
    ok: true,
    title: `Quest Flags: ${target.charName}`,
    table: parseSqlTable(raw),
    note: 'Active/Completed quest sets are stored as blobs; sizes indicate whether quest data is present.',
    raw,
  };
}

// inv_type soft labels (best-effort; unknown types show as "Type N").
const INV_LABELS = {
  0: 'Inventory', 1: 'Equipment', 2: 'Hotbar', 4: 'Thrall/Container',
  5: 'Building storage', 6: 'Container', 7: 'Quick slots', 13: 'Misc',
  15: 'Misc', 21: 'Misc',
};

const INV_LABEL = (t) => INV_LABELS[t] || `Container ${t}`;

async function viewInventory(rcon, cfg, target) {
  const id = toInt(target.dbId);
  // One row per (container, item) with how many stacks of it. Paged to beat the
  // ~10KB reply cap. (Per-stack quantity lives in a binary blob we don't decode.)
  const buildQuery = (lim, off) =>
    `sql SELECT inv_type, template_id, COUNT(*) AS stacks FROM item_inventory WHERE owner_id=${id} ` +
    `GROUP BY inv_type, template_id ORDER BY inv_type, stacks DESC LIMIT ${lim} OFFSET ${off};`;
  const rows = await sqlAll(rcon, buildQuery, 200);
  const items = rows.map((r) => ({
    invType: toInt(r.inv_type),
    container: INV_LABEL(toInt(r.inv_type)),
    templateId: toInt(r.template_id),
    stacks: toInt(r.stacks),
  })).filter((i) => i.templateId != null);
  const total = items.reduce((s, i) => s + i.stacks, 0);
  return { ok: true, title: `Inventory: ${target.charName}`, items, total };
}

// Building heatmap: real x/y per building root (verified ~13k rows).
// Conan caps each `sql` RCON reply at ~10KB (~250 rows). To read a large set we
// page through it with LIMIT/OFFSET until a short page signals the end.
async function sqlAll(rcon, buildQuery, page = 200, maxPages = 300) {
  const all = [];
  for (let i = 0; i < maxPages; i++) {
    const { rows } = parseSqlTable(await rcon.command(buildQuery(page, page * i)));
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

// Heatmap: bin building roots into a grid SERVER-SIDE so the result is a few
// hundred cells (well under the cap) and is a true density map. Each cell ->
// {x, y (cell center, world units), count}. Click->owner is resolved separately.
async function buildingHeatmap(rcon, cfg, opts = {}) {
  const BIN = Number(opts.bin) || 7000; // ~70m grid cells
  // "Enhanced" merges Exiled Lands + Siptah into one world; Siptah sits offset
  // at x > ~1.2M. Filter to the requested map's coordinate region.
  const bounds = opts.map === 'siptah'
    ? 'ap.x > 800000'
    : 'ap.x BETWEEN -500000 AND 500000 AND ap.y BETWEEN -500000 AND 500000';
  const where = opts.ownerId ? `WHERE b.owner_id=${toInt(opts.ownerId)} AND ${bounds}` : `WHERE ${bounds}`;
  const buildQuery = (lim, off) =>
    `sql SELECT CAST(ap.x/${BIN} AS INT) AS gx, CAST(ap.y/${BIN} AS INT) AS gy, COUNT(*) AS c ` +
    `FROM actor_position ap JOIN buildings b ON b.object_id=ap.id ${where} ` +
    `GROUP BY gx, gy ORDER BY c DESC LIMIT ${lim} OFFSET ${off};`;
  const rows = await sqlAll(rcon, buildQuery, 200);
  const cells = rows
    .map((r) => ({ x: (toInt(r.gx) + 0.5) * BIN, y: (toInt(r.gy) + 0.5) * BIN, count: toInt(r.c) }))
    .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.count);
  const total = cells.reduce((s, c) => s + c.count, 0);
  return { ok: true, title: 'Building Heatmap', cells, bin: BIN, count: total, cellCount: cells.length };
}

// Who owns the buildings near a world coordinate (for the heatmap click).
// Resolve a set of building-owner ids to {name,type,last}. Owner names read via a
// grouped LEFT JOIN come back as the literal "BLOB" in Conan's sql (notably the
// player char_name), so resolve from SINGLE-TABLE queries instead: guild names
// whole-table, player names by id chunk. Matches the original char-first ordering.
async function resolveOwnerNames(rcon, ownerIds) {
  const ids = [...new Set(ownerIds.map((x) => toInt(x)).filter(Boolean))];
  const guildName = {};
  (await sqlAll(rcon, (l, o) => `sql SELECT guildId AS id, name FROM guilds LIMIT ${l} OFFSET ${o};`, 120))
    .forEach((r) => { guildName[toInt(r.id)] = r.name; });
  const charInfo = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).join(',');
    if (!chunk) continue;
    parseSqlTable(await rcon.command(`sql SELECT id, lastTimeOnline AS last, char_name AS name FROM characters WHERE id IN (${chunk});`)).rows
      .forEach((r) => { charInfo[toInt(r.id)] = { name: r.name, last: toInt(r.last) || null }; });
  }
  const out = {};
  for (const oid of ids) {
    if (charInfo[oid]) out[oid] = { name: (charInfo[oid].name && charInfo[oid].name !== 'void') ? charInfo[oid].name : `Player #${oid}`, type: 'Player', last: charInfo[oid].last };
    else if (guildName[oid] != null) out[oid] = { name: (guildName[oid] && guildName[oid] !== 'void') ? guildName[oid] : `Clan #${oid}`, type: 'Clan', last: null };
    else out[oid] = { name: `Unknown (#${oid})`, type: 'Unknown', last: null };
  }
  return out;
}

async function buildingOwnerAt(rcon, cfg, { x, y, radius }) {
  const r = Number(radius) || 6000;
  const raw = await rcon.command(
    `sql SELECT b.owner_id AS owner_id, COUNT(*) AS pieces ` +
    `FROM actor_position ap JOIN buildings b ON b.object_id=ap.id ` +
    `WHERE ap.x BETWEEN ${Math.round(x - r)} AND ${Math.round(x + r)} ` +
    `AND ap.y BETWEEN ${Math.round(y - r)} AND ${Math.round(y + r)} ` +
    `GROUP BY b.owner_id ORDER BY pieces DESC LIMIT 1;`
  );
  const { rows } = parseSqlTable(raw);
  if (!rows.length) return { ok: true, owner: null };
  const oid = toInt(rows[0].owner_id); const pieces = toInt(rows[0].pieces);
  // resolve the single owner name via single-table lookups (joined name -> BLOB)
  let name = null;
  const ch = parseSqlTable(await rcon.command(`sql SELECT char_name AS n FROM characters WHERE id=${oid} LIMIT 1;`)).rows[0];
  if (ch && ch.n && ch.n !== 'void' && ch.n !== 'BLOB') name = ch.n;
  else {
    const g = parseSqlTable(await rcon.command(`sql SELECT name AS n FROM guilds WHERE guildId=${oid} LIMIT 1;`)).rows[0];
    if (g && g.n && g.n !== 'void') name = g.n;
  }
  return { ok: true, owner: name, ownerId: oid, pieces };
}

// Live positions of currently-online players (for the bottom-right mini-map).
// listplayers is the authority on who's online; one IN query fetches coords.
async function livePlayerPositions(rcon, cfg) {
  const players = await listPlayers(rcon);
  const ids = players.map((p) => p.userId).filter(Boolean).map((u) => `'${sqlEscape(u)}'`);
  if (!ids.length) return { ok: true, players: [], online: players.length };
  const raw = await rcon.command(
    `sql SELECT a.user AS userId, c.char_name AS name, ap.x AS x, ap.y AS y ` +
    `FROM account a JOIN characters c ON c.playerId=a.id JOIN actor_position ap ON ap.id=c.id ` +
    `WHERE a.user IN (${ids.join(',')});`
  );
  const pos = parseSqlTable(raw).rows
    .map((r) => ({ userId: r.userId, name: r.name, x: parseFloat(r.x), y: parseFloat(r.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return { ok: true, players: pos, online: players.length };
}

// Power-user: run any RCON command and return the raw reply.
async function rawCommand(rcon, cfg, cmd) {
  const raw = await rcon.command(String(cmd));
  return { ok: true, title: 'RCON', message: `> ${cmd}`, raw: String(raw) };
}
// Broadcast composer: centered popup to all players.
async function broadcastMessage(rcon, cfg, msg) {
  const m = String(msg).replace(/[\r\n]/g, ' ');
  const raw = await rcon.command(`broadcast ${m}`);
  return { ok: true, title: 'Broadcast', message: `Sent: ${m}`, raw };
}

// Top builders, for the heatmap owner filter and general overview.
// Counts real pieces (building_instances) and resolves owner to a player OR a
// clan name (owner_id can be either a character id or a guild id).
async function topBuilders(rcon, cfg, limit = 25) {
  const lim = toInt(limit) || 25;
  const top = parseSqlTable(await rcon.command(
    `sql SELECT b.owner_id AS owner_id, COUNT(*) AS pieces ` +
    `FROM building_instances bi JOIN buildings b ON b.object_id=bi.object_id ` +
    `GROUP BY b.owner_id ORDER BY pieces DESC LIMIT ${lim};`
  )).rows;
  const info = await resolveOwnerNames(rcon, top.map((r) => r.owner_id));
  const rows = top.map((r) => {
    const oid = toInt(r.owner_id);
    return { owner_id: oid, name: (info[oid] && info[oid].name) || `Unknown (#${oid})`, pieces: toInt(r.pieces) };
  });
  return { ok: true, title: 'Top Builders', table: { columns: ['owner_id', 'name', 'pieces'], rows } };
}

// ---- SERVER DASHBOARD -----------------------------------------------------
async function serverDashboard(rcon, cfg) {
  const players = await listPlayers(rcon);
  const one = async (sql) => { const r = parseSqlTable(await rcon.command('sql ' + sql + ';')).rows; return r.length ? toInt(r[0].n) : 0; };
  const chars = await one('SELECT COUNT(*) n FROM characters');
  const alive = await one('SELECT COUNT(*) n FROM characters WHERE isAlive=1');
  const clans = await one('SELECT COUNT(*) n FROM guilds');
  const buildings = await one('SELECT COUNT(*) n FROM building_instances'); // actual pieces
  const builders = await one('SELECT COUNT(DISTINCT owner_id) n FROM buildings');
  const now = Math.floor(Date.now() / 1000);
  const active7 = await one(`SELECT COUNT(*) n FROM characters WHERE lastTimeOnline > ${now - 7 * 86400}`);
  const active30 = await one(`SELECT COUNT(*) n FROM characters WHERE lastTimeOnline > ${now - 30 * 86400}`);
  let bans = 0;
  try { bans = (await listBans(rcon)).bans.length; } catch (e) {}
  return { ok: true, online: players.length, players, chars, alive, dead: chars - alive, clans, buildings, builders, active7, active30, bans };
}

// ---- BAN / WHITELIST ------------------------------------------------------
async function listBans(rcon) {
  const raw = await rcon.command('listbans');
  const ids = String(raw).split('\n').map((s) => s.trim()).filter((s) => /^\d{6,}$/.test(s));
  const bans = [];
  for (const pid of ids) {
    let name = null;
    try {
      const r = parseSqlTable(await rcon.command(
        `sql SELECT c.char_name AS n FROM characters c JOIN account a ON a.id=c.playerId WHERE a.platformId='${sqlEscape(pid)}' LIMIT 1;`
      )).rows;
      if (r.length && r[0].n && r[0].n !== 'void') name = r[0].n;
    } catch (e) {}
    bans.push({ platformId: pid, name });
  }
  return { ok: true, bans };
}
async function banPlayer(rcon, cfg, opts) {
  const sel = opts.selector || 'platformid';
  const reason = (opts.reason || 'Banned by admin').replace(/[\r\n]/g, ' ');
  const raw = await rcon.command(`banplayer ${sel} ${opts.id} ${reason}`);
  return { ok: true, title: 'Ban Player', message: `Banned ${opts.label || opts.id}.`, raw };
}
async function unbanPlayer(rcon, cfg, id) {
  const raw = await rcon.command(`unbanplayer ${id}`);
  return { ok: true, title: 'Unban', message: `Unbanned ${id}.`, raw };
}
async function whitelistPlayer(rcon, cfg, id, on) {
  const raw = await rcon.command(`${on ? 'whitelistplayer' : 'unwhitelistplayer'} ${id}`);
  return { ok: true, title: 'Whitelist', message: `${on ? 'Whitelisted' : 'Removed from whitelist'} ${id}.`, raw };
}

// ---- PLAYER FINDER --------------------------------------------------------
async function findCharacters(rcon, cfg, query) {
  const q = sqlEscape(String(query || '').trim());
  if (!q) return { ok: true, rows: [] };
  const raw = await rcon.command(
    `sql SELECT c.id AS id, c.char_name AS name, c.level AS level, c.isAlive AS alive, ` +
    `c.lastTimeOnline AS last, a.user AS userId, a.platformId AS platformId ` +
    `FROM characters c LEFT JOIN account a ON a.id=c.playerId ` +
    `WHERE c.char_name LIKE '%${q}%' ORDER BY c.lastTimeOnline DESC LIMIT 60;`
  );
  const rows = parseSqlTable(raw).rows.map((r) => ({
    dbId: toInt(r.id), charName: r.name, level: r.level, isAlive: r.alive,
    last: toInt(r.last), userId: r.userId && r.userId !== 'void' ? r.userId : null,
    platformId: r.platformId && r.platformId !== 'void' ? r.platformId : null,
  }));
  return { ok: true, rows };
}

// ---- BUILDING / LAND-CLAIM REPORT -----------------------------------------
// owner_id may be a character id OR a guild id (clan-owned), so resolve both.
async function buildingReport(rcon, cfg) {
  const now = Math.floor(Date.now() / 1000);
  // "objects" = rows in buildings (structure roots + standalone placeables) per
  // owner. NO name join here — joined owner names come back as "BLOB" in Conan's
  // sql, so names/last-online are resolved separately via resolveOwnerNames().
  const objRows = await sqlAll(rcon, (l, o) =>
    `sql SELECT b.owner_id AS oid, COUNT(*) AS objects FROM buildings b ` +
    `GROUP BY b.owner_id ORDER BY objects DESC LIMIT ${l} OFFSET ${o};`, 200);
  // "pieces" = actual placed building pieces, which live in building_instances.
  const pieceRows = await sqlAll(rcon, (l, o) =>
    `sql SELECT b.owner_id AS oid, COUNT(*) AS pieces FROM building_instances bi ` +
    `JOIN buildings b ON b.object_id=bi.object_id GROUP BY b.owner_id ORDER BY pieces DESC LIMIT ${l} OFFSET ${o};`, 200);
  const pieceMap = {}; pieceRows.forEach((r) => { pieceMap[toInt(r.oid)] = toInt(r.pieces); });
  const info = await resolveOwnerNames(rcon, objRows.map((r) => r.oid));
  const owners = objRows.map((r) => {
    const oid = toInt(r.oid);
    const o = info[oid] || { name: `Unknown (#${oid})`, type: 'Unknown', last: null };
    return {
      ownerId: oid, pieces: pieceMap[oid] || 0, objects: toInt(r.objects),
      name: o.name, type: o.type, last: o.last,
      idleDays: (o.type === 'Player' && o.last) ? Math.floor((now - o.last) / 86400) : null,
    };
  });
  owners.sort((a, b) => (b.pieces - a.pieces) || (b.objects - a.objects));
  const totalPieces = owners.reduce((s, o) => s + o.pieces, 0);
  const totalObjects = owners.reduce((s, o) => s + o.objects, 0);
  return { ok: true, owners, totalPieces, totalObjects, ownerCount: owners.length };
}

// ---- ABANDONED-BASE CLEANUP -----------------------------------------------
// Find bases whose owner is inactive past a threshold (or whose owner no longer
// exists), so they can be bulk-destroyed to reclaim server resources. Unlike the
// general Building Report, this computes idle time for CLANS (max member login)
// and surfaces orphaned/deleted owners as prime cleanup targets.
async function abandonedBases(rcon, cfg, opts = {}) {
  const days = Math.max(1, toInt(opts.days) || 14);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - days * 86400;
  // pieces per owner (actual placed pieces)
  const pieceRows = await sqlAll(rcon, (l, o) =>
    `sql SELECT b.owner_id AS oid, COUNT(*) AS pieces FROM building_instances bi ` +
    `JOIN buildings b ON b.object_id=bi.object_id GROUP BY b.owner_id ORDER BY pieces DESC LIMIT ${l} OFFSET ${o};`, 150);
  // Clan activity: a SINGLE-TABLE grouped query resolves correctly (the bare
  // `guild` column and grouped LEFT JOINs both come back as unreadable BLOB in
  // Conan's sql, so we must group on the characters table directly).
  const clanInfo = {};
  (await sqlAll(rcon, (l, o) =>
    `sql SELECT guild AS gid, MAX(lastTimeOnline) AS last, COUNT(*) AS members FROM characters ` +
    `WHERE guild>0 GROUP BY guild LIMIT ${l} OFFSET ${o};`, 150))
    .forEach((r) => { clanInfo[toInt(r.gid)] = { last: toInt(r.last) || null, members: toInt(r.members) }; });
  // Guild names (small page so the ~10KB response cap can't truncate a page and
  // make sqlAll stop early).
  const guildName = {};
  (await sqlAll(rcon, (l, o) => `sql SELECT guildId AS id, name FROM guilds LIMIT ${l} OFFSET ${o};`, 120))
    .forEach((r) => { guildName[toInt(r.id)] = r.name; });
  // Resolve player owners (those not matching a guild) by id chunks — plain
  // WHERE-IN selects return char_name/lastTimeOnline correctly.
  const charInfo = {};
  const candidateIds = pieceRows.map((r) => toInt(r.oid)).filter((oid) => oid && guildName[oid] == null);
  for (let i = 0; i < candidateIds.length; i += 100) {
    const chunk = candidateIds.slice(i, i + 100).join(',');
    if (!chunk) continue;
    parseSqlTable(await rcon.command(`sql SELECT id, lastTimeOnline AS last, char_name AS name FROM characters WHERE id IN (${chunk});`)).rows
      .forEach((r) => { charInfo[toInt(r.id)] = { last: toInt(r.last) || null, name: r.name }; });
  }

  const owners = [];
  for (const r of pieceRows) {
    const oid = toInt(r.oid);
    if (!oid) continue; // skip server/world-owned (owner_id 0)
    const pieces = toInt(r.pieces);
    let last = null, kind, name, members = null;
    if (guildName[oid] != null) { kind = 'clan'; name = (guildName[oid] && guildName[oid] !== 'void') ? guildName[oid] : `Clan #${oid}`; const ci = clanInfo[oid]; last = ci ? ci.last : null; members = ci ? ci.members : 0; }
    else if (charInfo[oid]) { kind = 'player'; const ci = charInfo[oid]; name = (ci.name && ci.name !== 'void') ? ci.name : `Player #${oid}`; last = ci.last; }
    else { kind = 'orphan'; name = `Deleted owner (#${oid})`; last = null; }
    // Conservative: a PLAYER is only "abandoned" with a concrete old timestamp
    // (never flag on missing data — an online player's lastTimeOnline is ~now, so
    // active players can't qualify). Clans qualify when their newest member login
    // is old (or they have no members). Orphans (owner row gone) always qualify.
    let abandoned;
    if (kind === 'orphan') abandoned = true;
    else if (kind === 'clan') abandoned = (last == null) || (last < cutoff);
    else abandoned = (last != null) && (last < cutoff);
    if (!abandoned) continue;
    owners.push({ ownerId: oid, name, kind, members, pieces,
      last, idleDays: last ? Math.floor((now - last) / 86400) : null });
  }
  owners.sort((a, b) => b.pieces - a.pieces);
  const totalPieces = owners.reduce((s, o) => s + o.pieces, 0);
  return { ok: true, days, owners, count: owners.length, totalPieces };
}

// Destroy every building owned by an owner id (character OR clan). Uses the
// game's own buildingquery command, which applies live (no restart needed).
async function destroyOwnerBuildings(rcon, cfg, ownerId) {
  const id = toInt(ownerId);
  if (!id) throw new Error('Invalid owner id.');
  const raw = await rcon.command(`buildingquery destroy ${id}`);
  return { ok: true, title: 'Cleanup', message: `Destroyed all buildings owned by #${id}.`, raw };
}

// ---- RAID / DESTRUCTION LOG (game_events) ----------------------------------
async function raidLog(rcon, cfg, opts = {}) {
  const off = toInt(opts.offset) || 0;
  const limit = 150;
  const conds = [];
  if (opts.filter) {
    const f = sqlEscape(opts.filter);
    conds.push(`(causerName LIKE '%${f}%' OR ownerName LIKE '%${f}%' OR causerGuildName LIKE '%${f}%' OR ownerGuildName LIKE '%${f}%' OR objectName LIKE '%${f}%')`);
  }
  if (opts.raidsOnly) conds.push(`causerName<>'' AND ownerName<>'' AND IFNULL(causerGuildName,'')<>IFNULL(ownerGuildName,'')`);
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const raw = await rcon.command(
    `sql SELECT worldTime, eventType, objectName, x, y, causerName, causerGuildName, ownerName, ownerGuildName ` +
    `FROM game_events ${where} ORDER BY worldTime DESC LIMIT ${limit} OFFSET ${off};`
  );
  const events = parseSqlTable(raw).rows.map((r) => ({
    time: toInt(r.worldTime), type: toInt(r.eventType), object: r.objectName || '',
    x: parseFloat(r.x), y: parseFloat(r.y),
    causer: r.causerName && r.causerName !== 'void' ? r.causerName : '',
    causerGuild: r.causerGuildName && r.causerGuildName !== 'void' ? r.causerGuildName : '',
    owner: r.ownerName && r.ownerName !== 'void' ? r.ownerName : '',
    ownerGuild: r.ownerGuildName && r.ownerGuildName !== 'void' ? r.ownerGuildName : '',
  }));
  return { ok: true, events, offset: off, limit };
}

// ---- CLAN / GUILD MANAGER --------------------------------------------------
async function clanList(rcon, cfg) {
  const guilds = await sqlAll(rcon, (l, o) => `sql SELECT guildId AS id, name, owner FROM guilds ORDER BY guildId LIMIT ${l} OFFSET ${o};`, 200);
  const members = await sqlAll(rcon, (l, o) => `sql SELECT guild AS g, COUNT(*) m FROM characters WHERE guild>0 GROUP BY guild LIMIT ${l} OFFSET ${o};`, 200);
  const builds = await sqlAll(rcon, (l, o) => `sql SELECT b.owner_id AS oid, COUNT(*) AS cnt FROM building_instances bi JOIN buildings b ON b.object_id=bi.object_id GROUP BY b.owner_id LIMIT ${l} OFFSET ${o};`, 200);
  const mMap = {}; members.forEach((r) => { mMap[toInt(r.g)] = toInt(r.m); });
  const bMap = {}; builds.forEach((r) => { bMap[toInt(r.oid)] = toInt(r.cnt); });
  const ownerIds = [...new Set(guilds.map((g) => toInt(g.owner)).filter((x) => x))];
  const nameMap = {};
  for (let i = 0; i < ownerIds.length; i += 100) {
    const chunk = ownerIds.slice(i, i + 100).join(',');
    if (!chunk) continue;
    parseSqlTable(await rcon.command(`sql SELECT id,char_name FROM characters WHERE id IN (${chunk});`)).rows.forEach((r) => { nameMap[toInt(r.id)] = r.char_name; });
  }
  const clans = guilds.map((g) => ({
    id: toInt(g.id), name: (g.name && g.name !== 'void') ? g.name : '(unnamed)',
    owner: nameMap[toInt(g.owner)] || `#${g.owner}`,
    members: mMap[toInt(g.id)] || 0, buildings: bMap[toInt(g.id)] || 0,
  }));
  clans.sort((a, b) => (b.members - a.members) || (b.buildings - a.buildings));
  return { ok: true, clans };
}
async function clanMembers(rcon, cfg, guildId) {
  const raw = await rcon.command(
    `sql SELECT id, char_name, level, isAlive, lastTimeOnline FROM characters WHERE guild=${toInt(guildId)} ORDER BY level DESC LIMIT 200;`
  );
  const members = parseSqlTable(raw).rows.map((r) => ({ dbId: toInt(r.id), charName: r.char_name, level: r.level, isAlive: r.isAlive, last: toInt(r.lastTimeOnline) }));
  return { ok: true, members };
}
async function renameGuild(rcon, cfg, guildId, name) {
  const raw = await rcon.command(`sql UPDATE guilds SET name='${sqlEscape(name)}' WHERE guildId=${toInt(guildId)};`);
  return { ok: true, title: 'Rename Clan', message: `Renamed clan ${guildId} to "${name}".`, note: RESTART_NOTE, raw };
}
async function setGuildOwner(rcon, cfg, guildId, charId) {
  const raw = await rcon.command(`sql UPDATE guilds SET owner=${toInt(charId)} WHERE guildId=${toInt(guildId)};`);
  return { ok: true, title: 'Set Clan Owner', message: `Set owner of clan ${guildId} to character ${charId}.`, note: RESTART_NOTE, raw };
}
async function disbandGuild(rcon, cfg, guildId) {
  const id = toInt(guildId);
  const r1 = await rcon.command(`sql UPDATE characters SET guild=NULL WHERE guild=${id};`);
  const r2 = await rcon.command(`sql DELETE FROM guilds WHERE guildId=${id};`);
  return { ok: true, title: 'Disband Clan', message: `Disbanded clan ${id} and cleared its members.`, note: RESTART_NOTE, raw: `${r1}\n${r2}` };
}

module.exports = {
  listPlayers, resolveDbCharacter, getCoords, getAdmin,
  kickPlayer, killPlayer, freezePlayer,
  teleportToPlayer, summonPlayer, sendHome,
  viewCharacter, editCharacter, deleteCharacter, removeBuildings, clearCooldowns,
  viewFeats, viewQuestFlags, viewInventory, buildingHeatmap, buildingOwnerAt, topBuilders,
  serverDashboard, listBans, banPlayer, unbanPlayer, whitelistPlayer, findCharacters,
  buildingReport, abandonedBases, destroyOwnerBuildings, raidLog, clanList, clanMembers, renameGuild, setGuildOwner, disbandGuild,
  livePlayerPositions, rawCommand, broadcastMessage,
};
