'use strict';
const net = require('net');

// Packet types
const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

// RCON client tuned for Conan Exiles' RconPlugin, which is NON-standard:
//   * It ignores the request id we send and returns its OWN sequential ids
//     (auth=0, first command=1, second=2, ...), so id-matching is useless.
//   * It has no usable multi-packet end-marker — sending an empty command
//     (the classic Source "sentinel" trick) returns "Couldn't parse the
//     command" instead of echoing back.
//   * It replies to commands with type 2 packets (not type 0).
//
// So we run commands SERIALLY (one in flight at a time) and read replies in
// arrival order. A command is considered complete after a short idle gap with
// no further packets (responses, even multi-packet ones, arrive clustered).
class RconClient {
  constructor({ host, port, password, timeout = 10000, idleMs = 300 }) {
    this.host = host;
    this.port = Number(port) || 25575;
    this.password = password;
    this.timeout = timeout;       // max wait for the FIRST byte of a reply
    this.idleMs = idleMs;         // quiet gap that marks a reply complete
    this.sock = null;
    this.connected = false;
    this.authed = false;
    this._buf = Buffer.alloc(0);
    this._queue = [];             // pending {cmd, resolve, reject}
    this._active = null;          // command in flight
    this._reqId = 0;
  }

  _encode(type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(b.length + 14);
    buf.writeInt32LE(b.length + 10, 0);
    buf.writeInt32LE(++this._reqId, 4);
    buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.authed) return resolve();
      const sock = net.connect({ host: this.host, port: this.port });
      this.sock = sock;
      let done = false;
      const fail = (err) => {
        if (done) return; done = true;
        this.connected = false; this.authed = false;
        try { sock.destroy(); } catch (_) {}
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const connTimer = setTimeout(() => fail(new Error(`Connection to ${this.host}:${this.port} timed out`)), this.timeout);
      this._authResolve = () => { if (done) return; done = true; clearTimeout(connTimer); resolve(); };
      this._authReject = fail;

      sock.on('connect', () => {
        this.connected = true;
        sock.write(this._encode(SERVERDATA_AUTH, this.password));
      });
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => {
        if (!this.authed) return fail(e);
        this._failActive(e);
      });
      sock.on('close', () => {
        clearTimeout(connTimer);
        const was = this.authed;
        this.connected = false; this.authed = false;
        if (!was && !done) return fail(new Error('Connection closed during authentication (check IP/port/password)'));
        this._failActive(new Error('RCON connection closed'));
        for (const q of this._queue.splice(0)) q.reject(new Error('RCON connection closed'));
      });
    });
  }

  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    while (this._buf.length >= 4) {
      const len = this._buf.readInt32LE(0);
      if (len < 10 || this._buf.length < len + 4) break;
      const pid = this._buf.readInt32LE(4);
      // body excludes the 2 trailing null bytes
      const body = this._buf.slice(12, 4 + len - 2).toString('utf8');
      this._buf = this._buf.slice(4 + len);
      this._handlePacket(pid, body);
    }
  }

  _handlePacket(pid, body) {
    if (!this.authed) {
      // Conan returns id=-1 (and/or closes) on bad password; otherwise success.
      if (pid === -1) return this._authReject(new Error('RCON authentication failed (wrong password)'));
      this.authed = true;
      this._authResolve();
      this._drain();
      return;
    }
    if (!this._active) return; // stray packet, ignore
    this._active.chunks.push(body);
    if (this._active.hardTimer) { clearTimeout(this._active.hardTimer); this._active.hardTimer = null; }
    clearTimeout(this._active.idleTimer);
    this._active.idleTimer = setTimeout(() => this._finishActive(), this.idleMs);
  }

  _finishActive() {
    const a = this._active;
    if (!a) return;
    this._active = null;
    if (a.idleTimer) clearTimeout(a.idleTimer);
    if (a.hardTimer) clearTimeout(a.hardTimer);
    a.resolve(a.chunks.join(''));
    this._drain();
  }

  _failActive(err) {
    const a = this._active;
    if (!a) return;
    this._active = null;
    if (a.idleTimer) clearTimeout(a.idleTimer);
    if (a.hardTimer) clearTimeout(a.hardTimer);
    a.reject(err instanceof Error ? err : new Error(String(err)));
  }

  _drain() {
    if (this._active || !this._queue.length || !this.authed) return;
    const a = this._queue.shift();
    this._active = a;
    a.chunks = [];
    // No reply at all within `timeout` => fail. Reset to idle-debounce once
    // the first packet arrives (see _handlePacket).
    a.hardTimer = setTimeout(() => {
      this._active = null;
      a.reject(new Error(`Command timed out (no response): ${a.cmd}`));
      this._drain();
    }, this.timeout);
    try {
      this.sock.write(this._encode(SERVERDATA_EXECCOMMAND, a.cmd));
    } catch (e) {
      this._active = null;
      if (a.hardTimer) clearTimeout(a.hardTimer);
      a.reject(e);
      this._drain();
    }
  }

  command(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.authed) return reject(new Error('Not connected/authenticated'));
      this._queue.push({ cmd, resolve, reject });
      this._drain();
    });
  }

  close() {
    try { if (this.sock) this.sock.end(); } catch (_) {}
    this.connected = false;
    this.authed = false;
  }
}

module.exports = { RconClient };
