'use strict';
const fs = require('fs');
const path = require('path');

// Config lives in the user's per-account data dir, not in the app bundle, so a
// shared copy of the app never carries anyone's credentials.
//
// Model: a list of servers the admin can tab between, plus the active one.
const DEFAULT_CONSOLE = {
  kill: 'Suicide',            // kills the targeted player
  teleportSelf: 'TeleportPlayer', // moves the executing player to x y z
  freeze: '',                 // no native vanilla freeze; set if you have one
  unfreeze: '',
};

const DEFAULTS = { servers: [], activeServerId: null };

function newServer(partial = {}) {
  return {
    id: partial.id || ('srv_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)),
    name: partial.name || 'New Server',
    host: partial.host || '',
    port: partial.port || 25575,
    password: partial.password || '',
    adminCharName: partial.adminCharName || '',
    makeAdmin: !!partial.makeAdmin,
    timeout: partial.timeout || 8000,
    consoleCommands: { ...DEFAULT_CONSOLE, ...(partial.consoleCommands || {}) },
  };
}

function configPath(userDataDir) {
  return path.join(userDataDir, 'servers.json');
}

function load(userDataDir) {
  try {
    const p = configPath(userDataDir);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const servers = Array.isArray(data.servers) ? data.servers.map(newServer) : [];
      let activeServerId = data.activeServerId;
      if (!servers.find((s) => s.id === activeServerId)) activeServerId = servers[0] ? servers[0].id : null;
      return { servers, activeServerId };
    }
  } catch (e) { /* fall through */ }
  return { ...DEFAULTS };
}

function save(userDataDir, cfg) {
  const p = configPath(userDataDir);
  const out = {
    servers: (cfg.servers || []).map(newServer),
    activeServerId: cfg.activeServerId || (cfg.servers && cfg.servers[0] ? cfg.servers[0].id : null),
  };
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

module.exports = { load, save, configPath, newServer, DEFAULTS, DEFAULT_CONSOLE };
