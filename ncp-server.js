// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * ncp-server.js  --  NetWare Core Protocol server over UDP
 *
 * Ported from TurboPower BTF NWBase.PAS / NWConn.PAS / NWSema.PAS /
 *   NWTts.PAS / NWMsg.PAS
 *
 * Listens on UDP port 524 (the IANA-assigned NCP port, also used by
 * NetWare/IP).  Implements:
 *
 *   Function 0x61 - Create Service Connection (negotiate buffer)
 *   Function 0x17 - Bindery (all sub-functions)
 *   Function 0x20 - Semaphores  (nwOpenSema/WaitOnSema/SignalSema/CloseSema)
 *   Function 0x22 - TTS         (Begin/End/Abort/IsCommitted)
 *                   TTS Begin/End/Abort are wired to GitHubVolume
 *                   branch transactions when a file service is attached.
 *   Function 0x21 - Broadcast   (Send/Get message, mode)
 *   Function 0x63 - Logout      (flushes open file handles via endOfJob)
 *
 * Connection reaper runs every CONN_TIMEOUT_MS to purge stale connections
 * and flush their open file handles.
 */

const dgram  = require('dgram');
const {
  NCP_FUNC, BIND_SUB, SEMA_SUB, TTS_SUB, BCAST_SUB, ERR, DESTROY_TYPE,
  buildReply, buildServerBusy, parseRequest,
  readNetLong, readNetWord, netLong, netWord,
  encodePStr, decodePStr,
} = require('./ncp-packet');
const { Bindery } = require('./nw-bindery');

const NCP_PORT         = 524;
const MAX_BUFFER_SIZE  = 1024;
const CONN_TIMEOUT_MS  = 30_000;
const REAPER_INTERVAL  = 10_000;

// ---- Semaphore store -------------------------------------------------------
class SemaphoreStore {
  constructor() {
    this._semas   = new Map();
    this._byName  = new Map();
    this._nextHdl = 1;
  }

  open(name, initialValue) {
    const key = name.toUpperCase();
    if (this._byName.has(key)) {
      const hdl = this._byName.get(key);
      const s   = this._semas.get(hdl);
      s.openCount++;
      return { err: ERR.SUCCESS, handle: hdl, openCount: s.openCount };
    }
    if (initialValue < 0 || initialValue > 127)
      return { err: ERR.BAD_DATA, handle: 0, openCount: 0 };

    const hdl = this._nextHdl++;
    this._semas.set(hdl, { name: key, value: initialValue, openCount: 1, waiters: [] });
    this._byName.set(key, hdl);
    return { err: ERR.SUCCESS, handle: hdl, openCount: 1 };
  }

  examine(handle) {
    const s = this._semas.get(handle);
    if (!s) return { err: ERR.SEMA_INVALID_HDL };
    return { err: ERR.SUCCESS, value: s.value, openCount: s.openCount };
  }

  wait(handle, timeoutTicks) {
    const s = this._semas.get(handle);
    if (!s) return ERR.SEMA_INVALID_HDL;
    if (s.value > 0) { s.value--; return ERR.SUCCESS; }
    return ERR.SEMA_TIMEOUT;
  }

  signal(handle) {
    const s = this._semas.get(handle);
    if (!s) return ERR.SEMA_INVALID_HDL;
    if (s.value >= 127) return ERR.SEMA_OVERFLOW;
    s.value++;
    return ERR.SUCCESS;
  }

  close(handle) {
    const s = this._semas.get(handle);
    if (!s) return ERR.SEMA_INVALID_HDL;
    s.openCount--;
    if (s.openCount <= 0) {
      this._byName.delete(s.name);
      this._semas.delete(handle);
    }
    return ERR.SUCCESS;
  }
}

// ---- TTS store (per-server, tracks state for isCommitted queries) ----------
class TTSStore {
  constructor() {
    this._txns       = new Map();
    this._nextId     = 1;
    this._enabled    = true;
    this._appLogical = 0;
    this._appPhysical= 0;
  }

  available() { return this._enabled; }

  begin() {
    if (!this._enabled) return { err: ERR.TTS_UNAVAILABLE, id: 0 };
    const id = this._nextId++;
    this._txns.set(id, { state: 'open', ts: Date.now() });
    return { err: ERR.SUCCESS, id };
  }

  end(id) {
    const t = this._txns.get(id);
    if (!t) return ERR.BAD_DATA;
    t.state = 'committed';
    return ERR.SUCCESS;
  }

  abort(id) {
    const t = this._txns.get(id);
    if (!t) return ERR.BAD_DATA;
    this._txns.delete(id);
    return ERR.SUCCESS;
  }

  isCommitted(id) {
    const t = this._txns.get(id);
    return t && t.state === 'committed';
  }

  enable()  { this._enabled = true;  return true; }
  disable() { this._enabled = false; return true; }
}

// ---- Broadcast message store ----------------------------------------------
class BroadcastStore {
  constructor() {
    this._messages = new Map();
    this._modes    = new Map();
  }

  send(toConnId, msg) {
    const mode = this._modes.get(toConnId) || 0;
    if (mode === 2) return false;
    if (!this._messages.has(toConnId)) this._messages.set(toConnId, []);
    this._messages.get(toConnId).push(msg);
    return true;
  }

  get(connId) {
    const msgs = this._messages.get(connId) || [];
    this._messages.delete(connId);
    return msgs[0] || null;
  }

  setMode(connId, mode) { this._modes.set(connId, mode); }
  getMode(connId)       { return this._modes.get(connId) || 0; }
}

// ---- NCP Server -----------------------------------------------------------

class NCPServer {
  constructor(port = NCP_PORT, host = '0.0.0.0', options = {}) {
    this._port      = port;
    this._host      = host;
    this._socket    = null;
    this._conns     = new Map();
    this._nextConn  = 1;
    this._bindery   = new Bindery();
    this._semas     = new SemaphoreStore();
    this._tts       = new TTSStore();
    this._bcast     = new BroadcastStore();
    this._fileSvc   = options.fileService || null;
    this._log       = [];
    this._reaper    = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._socket = dgram.createSocket('udp4');
      this._socket.on('error', reject);
      this._socket.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
      this._socket.bind(this._port, this._host, () => {
        const addr = this._socket.address();
        console.log(`[NCP] Server listening on ${addr.address}:${addr.port}`);
        this._reaper = setInterval(() => this._reapConnections(), REAPER_INTERVAL);
        this._reaper.unref(); // don't prevent process exit
        resolve(this);
      });
    });
  }

  stop() {
    if (this._reaper) { clearInterval(this._reaper); this._reaper = null; }
    if (this._socket) {
      try { this._socket.close(); } catch (_) {}
      this._socket.unref();
      this._socket = null;
    }
  }

  // ---- Connection reaper --------------------------------------------------
  // Purge connections that haven't been seen within CONN_TIMEOUT_MS.
  // Flushes open file handles via fileSvc.endOfJob() and aborts any
  // in-flight TTS branch transaction on the GitHub volume.

  _reapConnections() {
    const deadline = Date.now() - CONN_TIMEOUT_MS;
    for (const [connId, conn] of this._conns) {
      if (conn.lastSeen < deadline) {
        console.log(`[NCP] Reaping stale connection connId=${connId}`);
        this._cleanupConn(connId, conn).catch(e =>
          console.error(`[NCP] Reaper cleanup error connId=${connId}:`, e.message)
        );
        this._conns.delete(connId);
      }
    }
  }

  async _cleanupConn(connId, conn) {
    // Abort any in-flight TTS branch transaction
    if (conn.ttsActive !== null && this._fileSvc) {
      await this._abortVolTxns(conn).catch(() => {});
    }
    // Flush open file handles
    if (this._fileSvc) {
      await this._fileSvc.endOfJob(connId).catch(() => {});
    }
  }

  // ---- Volume TTS helpers -------------------------------------------------
  // These wire the NCP-level TTS calls to GitHubVolume branch operations.
  // Each connection tracks:
  //   conn.ttsActive   - current NCP txn id (null if none)
  //   conn.ttsVolTxns  - Map<volName, volTxnId>

  _beginVolTxns(conn) {
    // beginTransaction() is synchronous in GitHubVolume
    // (creates branch async fire-and-forget internally)
    if (!this._fileSvc) return;
    conn.ttsVolTxns = new Map();
    for (const [name, vol] of this._fileSvc._volumes) {
      const vtid = vol.beginTransaction();
      conn.ttsVolTxns.set(name, vtid);
    }
  }

  async _endVolTxns(conn) {
    if (!this._fileSvc || !conn.ttsVolTxns) return;
    for (const [name, vol] of this._fileSvc._volumes) {
      const vtid = conn.ttsVolTxns.get(name);
      if (vtid !== undefined) await vol.endTransaction(vtid);
    }
    conn.ttsVolTxns.clear();
  }

  async _abortVolTxns(conn) {
    if (!this._fileSvc || !conn.ttsVolTxns) return;
    for (const [name, vol] of this._fileSvc._volumes) {
      const vtid = conn.ttsVolTxns.get(name);
      if (vtid !== undefined) await vol.abortTransaction(vtid).catch(() => {});
    }
    conn.ttsVolTxns.clear();
  }

  // ---- Packet I/O ---------------------------------------------------------

  _send(data, host, port) {
    this._socket.send(data, 0, data.length, port, host);
  }

  _reply(req, rinfo, completion, data) {
    const pkt = buildReply(req.seq, req.connLo, req.connHi, req.task, completion, data);
    this._send(pkt, rinfo.address, rinfo.port);
  }

  _log_req(req, rinfo, note) {
    const entry = {
      ts:   new Date().toISOString(),
      from: `${rinfo.address}:${rinfo.port}`,
      func: `0x${req.func.toString(16).padStart(2,'0')}`,
      note,
    };
    this._log.push(entry);
    if (this._log.length > 1000) this._log.shift(); // cap log
    console.log(`[NCP] ${entry.ts} ${entry.from} func=${entry.func} ${note}`);
  }

  _onPacket(msg, rinfo) {
    const req = parseRequest(msg);
    if (!req) return;

    // ---- Destroy Service Connection (0x5555) ----------------------------
    // Client is terminating — clean up exactly like Logout, no reply sent.
    if (req.isDestroy) {
      const destroyConnId = req.connLo | (req.connHi << 8);
      const destroyConn   = this._conns.get(destroyConnId);
      this._log_req(req, rinfo, `DESTROY connId=${destroyConnId}`);
      this._conns.delete(destroyConnId);
      if (destroyConn) {
        this._cleanupConn(destroyConnId, destroyConn).catch(e =>
          console.error(`[NCP] Destroy cleanup error connId=${destroyConnId}:`, e.message)
        );
      }
      return; // No reply for Destroy
    }

    // ---- Create Service Connection ----------------------------------------
    if (req.isConnect) {
      const connId = this._nextConn++;
      const connLo = connId & 0xFF;
      const connHi = (connId >> 8) & 0xFF;
      this._conns.set(connId, {
        connLo, connHi,
        addr: rinfo.address, port: rinfo.port,
        seq: 0, lastSeen: Date.now(), id: connId,
        ttsActive:  null,   // current NCP TTS txn id
        ttsVolTxns: null,   // Map<volName, volTxnId> for branch transactions
      });
      const reply = Buffer.alloc(2);
      reply.writeUInt16BE(MAX_BUFFER_SIZE, 0);
      this._reply({ seq: req.seq, connLo, connHi, task: req.task }, rinfo, 0, reply);
      this._log_req(req, rinfo, `CONNECT -> connId=${connId}`);
      return;
    }

    const connId = req.connLo | (req.connHi << 8);
    const conn   = this._conns.get(connId);
    if (!conn) {
      this._reply(req, rinfo, 0x88, null);
      return;
    }
    conn.lastSeen = Date.now();

    switch (req.func) {

      // ---- Bindery (0x17) -------------------------------------------------
      case NCP_FUNC.BINDERY: {
        const subFunc = req.data[0];
        const data    = req.data.slice(1);
        const result  = this._bindery.handle(subFunc, data);
        this._log_req(req, rinfo, `BINDERY sub=0x${subFunc.toString(16)} err=0x${result.err.toString(16)}`);
        const ncpErr = result.err === ERR.SUCCESS ? 0x00 : ((result.err >> 8) & 0xFF);
        this._reply(req, rinfo, ncpErr, result.reply || Buffer.alloc(0));
        break;
      }

      // ---- Semaphores (0x20) ----------------------------------------------
      case NCP_FUNC.SEMAPHORE: {
        const subFunc = req.data[0];
        let reply = null, err = ERR.SUCCESS;

        if (subFunc === SEMA_SUB.OPEN) {
          const initVal  = req.data.readInt8(1);
          const nameLen  = req.data[2];
          const name     = req.data.slice(3, 3 + nameLen).toString('ascii');
          const res = this._semas.open(name, initVal);
          err = res.err;
          if (err === ERR.SUCCESS) {
            reply = Buffer.alloc(5);
            reply.writeUInt32BE(res.handle, 0);
            reply[4] = res.openCount & 0xFF;
          }
          this._log_req(req, rinfo, `SEMA OPEN "${name}" handle=${res.handle}`);
        }
        else if (subFunc === SEMA_SUB.EXAMINE) {
          const handle = req.data.readUInt32BE(1);
          const res    = this._semas.examine(handle);
          err = res.err;
          if (err === ERR.SUCCESS) {
            reply = Buffer.alloc(3);
            reply.writeInt16BE(res.value, 0);
            reply[2] = res.openCount & 0xFF;
          }
          this._log_req(req, rinfo, `SEMA EXAMINE handle=${handle}`);
        }
        else if (subFunc === SEMA_SUB.WAIT) {
          const handle  = req.data.readUInt32BE(1);
          const timeout = req.data.readUInt16BE(5);
          err = this._semas.wait(handle, timeout);
          reply = Buffer.alloc(0);
          this._log_req(req, rinfo, `SEMA WAIT handle=${handle} timeout=${timeout} -> ${err}`);
        }
        else if (subFunc === SEMA_SUB.SIGNAL) {
          const handle = req.data.readUInt32BE(1);
          err = this._semas.signal(handle);
          reply = Buffer.alloc(0);
          this._log_req(req, rinfo, `SEMA SIGNAL handle=${handle} -> ${err}`);
        }
        else if (subFunc === SEMA_SUB.CLOSE) {
          const handle = req.data.readUInt32BE(1);
          err = this._semas.close(handle);
          reply = Buffer.alloc(0);
          this._log_req(req, rinfo, `SEMA CLOSE handle=${handle}`);
        }

        const ncpErr = err === ERR.SUCCESS ? 0 : ((err >> 8) & 0xFF) || 0xFF;
        this._reply(req, rinfo, ncpErr, reply || Buffer.alloc(0));
        break;
      }

      // ---- TTS (0x22) ------------------------------------------------------
      // In-memory TTSStore handles state tracking (isCommitted, enable/disable).
      // When a file service with GitHubVolume backends is attached, Begin/End/Abort
      // also drive branch-per-transaction on every volume: Begin opens a branch,
      // End merges it to main, Abort deletes the branch.
      case NCP_FUNC.TTS: {
        const subFunc = req.data[0];

        if (subFunc === TTS_SUB.AVAILABLE) {
          const avail = this._tts.available();
          this._log_req(req, rinfo, `TTS AVAILABLE -> ${avail}`);
          // NCP convention: reply completion 0xFF when TTS IS available
          this._reply(req, rinfo, avail ? 0xFF : 0x00, Buffer.alloc(0));
          break;
        }

        if (subFunc === TTS_SUB.BEGIN) {
          if (!this._tts.available()) {
            this._log_req(req, rinfo, 'TTS BEGIN -> unavailable');
            this._reply(req, rinfo, 0xFF, Buffer.alloc(0));
            break;
          }
          const res = this._tts.begin();
          conn.ttsActive = res.id;
          this._beginVolTxns(conn); // sync: creates branch async internally
          this._log_req(req, rinfo, `TTS BEGIN -> id=${res.id} volBranches=${conn.ttsVolTxns ? conn.ttsVolTxns.size : 0}`);
          this._reply(req, rinfo, 0x00, Buffer.alloc(0));
          break;
        }

        if (subFunc === TTS_SUB.END) {
          const id = conn.ttsActive;
          if (id === null) {
            this._log_req(req, rinfo, 'TTS END -> no active txn');
            this._reply(req, rinfo, 0xFF, Buffer.alloc(0));
            break;
          }
          const ttsErr = this._tts.end(id);
          const reply = Buffer.alloc(4);
          reply.writeUInt32BE(id, 0);
          conn.ttsActive = null;
          this._log_req(req, rinfo, `TTS END -> id=${id} merging ${conn.ttsVolTxns ? conn.ttsVolTxns.size : 0} vol branch(es)`);
          // Merge vol branches async; reply immediately (matches real NW behavior)
          this._endVolTxns(conn).catch(e =>
            console.error(`[NCP] TTS END vol merge error:`, e.message)
          );
          this._reply(req, rinfo, ttsErr === ERR.SUCCESS ? 0 : 0xFF, reply);
          break;
        }

        if (subFunc === TTS_SUB.ABORT) {
          const id = conn.ttsActive;
          const ttsErr = id !== null ? this._tts.abort(id) : ERR.BAD_DATA;
          if (id === conn.ttsActive) conn.ttsActive = null;
          this._log_req(req, rinfo, `TTS ABORT id=${id} aborting ${conn.ttsVolTxns ? conn.ttsVolTxns.size : 0} vol branch(es)`);
          // Delete vol branches async
          this._abortVolTxns(conn).catch(e =>
            console.error(`[NCP] TTS ABORT vol delete error:`, e.message)
          );
          const ncpE = ttsErr === ERR.SUCCESS ? 0 : 0xFF;
          this._reply(req, rinfo, ncpE, Buffer.alloc(0));
          break;
        }

        if (subFunc === TTS_SUB.IS_COMMITTED) {
          const id = req.data.readUInt32BE(1);
          const committed = this._tts.isCommitted(id);
          this._log_req(req, rinfo, `TTS IS_COMMITTED id=${id} -> ${committed}`);
          this._reply(req, rinfo, committed ? 0x00 : 0xFF, Buffer.alloc(0));
          break;
        }

        if (subFunc === TTS_SUB.ENABLE) {
          this._tts.enable();
          this._log_req(req, rinfo, 'TTS ENABLE');
          this._reply(req, rinfo, 0, Buffer.alloc(0));
          break;
        }

        if (subFunc === TTS_SUB.DISABLE) {
          this._tts.disable();
          this._log_req(req, rinfo, 'TTS DISABLE');
          this._reply(req, rinfo, 0, Buffer.alloc(0));
          break;
        }

        this._log_req(req, rinfo, `TTS UNKNOWN sub=0x${subFunc.toString(16)}`);
        this._reply(req, rinfo, 0xFF, Buffer.alloc(0));
        break;
      }

      // ---- Broadcast (0x21) -----------------------------------------------
      case NCP_FUNC.BROADCAST: {
        const subFunc = req.data[0];
        let reply = null;

        if (subFunc === BCAST_SUB.SEND_MESSAGE) {
          const connCount = req.data[1];
          let off = 2;
          for (let i = 0; i < connCount; i++) {
            const targetConn = req.data.readUInt16BE(off); off += 2;
            const msgLen     = req.data[off++];
            const msg        = req.data.slice(off, off + msgLen).toString('ascii'); off += msgLen;
            this._bcast.send(targetConn, msg);
          }
          reply = Buffer.alloc(connCount + 1);
          reply[0] = connCount;
          this._log_req(req, rinfo, `BCAST SEND to ${connCount} connections`);
        }
        else if (subFunc === BCAST_SUB.GET_MESSAGE) {
          const msg = this._bcast.get(connId) || '';
          reply = Buffer.alloc(msg.length + 1);
          reply[0] = msg.length;
          Buffer.from(msg, 'ascii').copy(reply, 1);
          this._log_req(req, rinfo, `BCAST GET -> "${msg}"`);
        }
        else if (subFunc === BCAST_SUB.GET_BCAST_MODE) {
          reply = Buffer.alloc(1);
          reply[0] = this._bcast.getMode(connId);
          this._log_req(req, rinfo, `BCAST GET_MODE -> ${reply[0]}`);
        }
        else if (subFunc === BCAST_SUB.ENABLE_BCAST) {
          this._bcast.setMode(connId, 0);
          reply = Buffer.alloc(0);
          this._log_req(req, rinfo, 'BCAST ENABLE');
        }
        else if (subFunc === BCAST_SUB.DISABLE_BCAST) {
          this._bcast.setMode(connId, 2);
          reply = Buffer.alloc(0);
          this._log_req(req, rinfo, 'BCAST DISABLE');
        }

        this._reply(req, rinfo, 0, reply || Buffer.alloc(0));
        break;
      }

      // ---- Logout (0x63) --------------------------------------------------
      // Abort any in-flight TTS branch, flush open file handles, remove conn.
      case NCP_FUNC.LOGOUT: {
        this._log_req(req, rinfo, `LOGOUT connId=${connId}`);
        this._reply(req, rinfo, 0, Buffer.alloc(0));
        this._conns.delete(connId);
        // Cleanup async after reply is sent
        this._cleanupConn(connId, conn).catch(e =>
          console.error(`[NCP] Logout cleanup error connId=${connId}:`, e.message)
        );
        break;
      }

      // ---- File service (everything else) ---------------------------------
      default:
        if (this._fileSvc) {
          // Emit 0x9999 Server Busy before dispatching async file operation.
          // This tells the client the request is being processed; it will
          // retry when it receives 0x9999, and we send the real reply when done.
          const busyPkt = buildServerBusy(req.seq, req.connLo, req.connHi, req.task);
          this._send(busyPkt, rinfo.address, rinfo.port);

          this._fileSvc.handle(req.func, req.subFunc || 0, req.data || Buffer.alloc(0), connId)
            .then(({ err, reply }) => {
              this._reply(req, rinfo, err, reply || Buffer.alloc(0));
              this._log_req(req, rinfo, `FILE func=0x${req.func.toString(16)} err=0x${err.toString(16)}`);
            })
            .catch(e => {
              this._log_req(req, rinfo, `FILE func=0x${req.func.toString(16)} EXCEPTION: ${e.message}`);
              this._reply(req, rinfo, 0xFF, Buffer.alloc(0));
            });
        } else {
          this._log_req(req, rinfo, `UNKNOWN func=0x${req.func.toString(16)}`);
          this._reply(req, rinfo, 0x7E, Buffer.alloc(0));
        }
    }
  }

  get bindery()  { return this._bindery; }
  get log()      { return this._log; }
  get conns()    { return this._conns; }
}

module.exports = { NCPServer };
