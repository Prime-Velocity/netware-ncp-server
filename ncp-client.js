// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * ncp-client.js  --  NetWare Core Protocol client
 *
 * Mirrors the Pascal API from TurboPower BTF:
 *   NWConn.PAS  -> connect/disconnect, server info, time
 *   NWBind.PAS  -> full bindery CRUD
 *   NWSema.PAS  -> semaphore open/wait/signal/close/examine
 *   NWTts.PAS   -> TTS begin/end/abort/isCommitted
 *   NWMsg.PAS   -> broadcast send/get/mode
 *
 * Transport: UDP to port 524 (NCP/IP per NetWare/IP spec).
 * The original Pascal code used int $21 via NETX or VLM transport
 * calls — we replace that with UDP dgram.
 */

const dgram  = require('dgram');
const {
  NCP_FUNC, BIND_SUB, SEMA_SUB, TTS_SUB, BCAST_SUB, ERR, OBJ_TYPE,
  buildRequest, buildConnectRequest, parseReply,
  netLong, netWord, encodePStr, encodeAsciiz,
} = require('./ncp-packet');

const NCP_PORT    = 524;
const TIMEOUT_MS  = 5000;

class NCPClient {
  constructor(host = '127.0.0.1', port = NCP_PORT) {
    this._host   = host;
    this._port   = port;
    this._socket = null;
    this._connLo = 0xFF;
    this._connHi = 0xFF;
    this._seq    = 0;
    this._task   = 1;
    this._pending = new Map(); // seq -> { resolve, reject, timer }
  }

  // ---- Transport -----------------------------------------------------------

  async connect() {
    await this._openSocket();
    const pkt   = buildConnectRequest();
    const reply = await this._sendRaw(pkt);
    if (!reply.ok) throw new Error(`NCP connect failed: completion=0x${reply.completion.toString(16)}`);
    this._connLo = reply.connLo;
    this._connHi = reply.connHi;
    // Read negotiated buffer size from reply data
    const bufSize = reply.data.length >= 2 ? reply.data.readUInt16BE(0) : 1024;
    return { connLo: this._connLo, connHi: this._connHi, bufferSize: bufSize };
  }

  async disconnect() {
    await this._call(NCP_FUNC.LOGOUT, Buffer.alloc(0));
    this._socket.close();
    this._socket = null;
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      this._socket = dgram.createSocket('udp4');
      this._socket.on('error', err => {
        for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this._pending.clear();
      });
      this._socket.on('message', msg => {
        const reply = parseReply(msg);
        if (!reply) return;
        const p = this._pending.get(reply.seq);
        if (!p) return;
        clearTimeout(p.timer);
        this._pending.delete(reply.seq);
        p.resolve(reply);
      });
      this._socket.bind(0, () => resolve());
    });
  }

  _sendRaw(pkt) {
    return new Promise((resolve, reject) => {
      const seq = pkt[2]; // seq is always byte 2
      const timer = setTimeout(() => {
        this._pending.delete(seq);
        reject(new Error(`NCP timeout seq=${seq}`));
      }, TIMEOUT_MS);
      this._pending.set(seq, { resolve, reject, timer });
      this._socket.send(pkt, 0, pkt.length, this._port, this._host);
    });
  }

  async _call(func, data) {
    const seq = (this._seq = (this._seq + 1) & 0xFF);
    const pkt = buildRequest(seq, this._connLo, this._connHi, this._task, func, data);
    const reply = await this._sendRaw(pkt);
    return reply;
  }

  _binderyCall(subFunc, data) {
    const d = Buffer.alloc(1 + data.length);
    d[0] = subFunc;
    data.copy(d, 1);
    return this._call(NCP_FUNC.BINDERY, d);
  }

  _semaCall(subFunc, data) {
    const d = Buffer.alloc(1 + (data ? data.length : 0));
    d[0] = subFunc;
    if (data) data.copy(d, 1);
    return this._call(NCP_FUNC.SEMAPHORE, d);
  }

  _ttsCall(subFunc, data) {
    const d = Buffer.alloc(1 + (data ? data.length : 0));
    d[0] = subFunc;
    if (data) data.copy(d, 1);
    return this._call(NCP_FUNC.TTS, d);
  }

  // ---- Server info / time  (nwGetServerInfo, nwGetServerTime) --------------

  async getServerInfo() {
    const r = await this._binderyCall(BIND_SUB.GET_SERVER_INFO, Buffer.alloc(0));
    if (!r.ok) throw this._err(r, 'getServerInfo');
    return {
      name      : r.data.slice(0, 48).toString('ascii').replace(/\0/g, ''),
      version   : `${r.data[48]}.${r.data[49]}`,
      maxConns  : r.data.readUInt16BE(50),
      usedConns : r.data.readUInt16BE(52),
      maxVols   : r.data.readUInt16BE(54),
      sftLevel  : r.data[57],
      ttsLevel  : r.data[58],
    };
  }

  async getServerTime() {
    const r = await this._binderyCall(BIND_SUB.GET_SERVER_TIME, Buffer.alloc(0));
    if (!r.ok) throw this._err(r, 'getServerTime');
    return {
      year  : r.data[0] + 1980,
      month : r.data[1],
      day   : r.data[2],
      hour  : r.data[3],
      minute: r.data[4],
      second: r.data[5],
      weekday: r.data[6],
    };
  }

  // ---- Bindery (nwbXxx in NWBind.PAS) ------------------------------------

  async createObject(name, type, flags = 0x00, security = 0x31) {
    const d = Buffer.alloc(4 + 1 + name.length);
    d[0] = flags; d[1] = security;
    d.writeUInt16BE(type, 2);
    d[4] = name.length;
    Buffer.from(name.toUpperCase(), 'ascii').copy(d, 5);
    const r = await this._binderyCall(BIND_SUB.CREATE_OBJECT, d);
    if (!r.ok) throw this._err(r, 'createObject');
    return r.data.length >= 4 ? r.data.readUInt32BE(0) : 0;
  }

  async deleteObject(name, type) {
    const d = Buffer.alloc(3 + name.length);
    d.writeUInt16BE(type, 0);
    d[2] = name.length;
    Buffer.from(name.toUpperCase(), 'ascii').copy(d, 3);
    const r = await this._binderyCall(BIND_SUB.DELETE_OBJECT, d);
    if (!r.ok) throw this._err(r, 'deleteObject');
  }

  async getObjectID(name, type) {
    const d = Buffer.alloc(3 + name.length);
    d.writeUInt16BE(type, 0);
    d[2] = name.length;
    Buffer.from(name.toUpperCase(), 'ascii').copy(d, 3);
    const r = await this._binderyCall(BIND_SUB.GET_OBJECT_ID, d);
    if (!r.ok) throw this._err(r, 'getObjectID');
    return {
      id  : r.data.readUInt32BE(0),
      type: r.data.readUInt16BE(4),
      name: r.data.slice(6).toString('ascii').replace(/\0/g, ''),
    };
  }

  async getObjectName(id) {
    const d = Buffer.alloc(4);
    d.writeUInt32BE(id, 0);
    const r = await this._binderyCall(BIND_SUB.GET_OBJECT_NAME, d);
    if (!r.ok) throw this._err(r, 'getObjectName');
    return {
      id  : r.data.readUInt32BE(0),
      type: r.data.readUInt16BE(4),
      name: r.data.slice(6).toString('ascii').replace(/\0/g, ''),
    };
  }

  async scanObjects(pattern = '*', type = OBJ_TYPE.WILD) {
    const results = [];
    let lastId = 0xFFFFFFFF;
    while (true) {
      const d = Buffer.alloc(7 + pattern.length);
      d.writeUInt32BE(lastId, 0);
      d.writeUInt16BE(type, 4);
      d[6] = pattern.length;
      Buffer.from(pattern.toUpperCase(), 'ascii').copy(d, 7);
      const r = await this._binderyCall(BIND_SUB.SCAN_OBJECT, d);
      if (!r.ok) break;
      const obj = {
        id      : r.data.readUInt32BE(0),
        type    : r.data.readUInt16BE(4),
        name    : r.data.slice(6, 54).toString('ascii').replace(/\0/g,''),
        flags   : r.data[54],
        security: r.data[55],
      };
      results.push(obj);
      lastId = obj.id;
    }
    return results;
  }

  async createProperty(objName, objType, propName, flags = 0x00, security = 0x31) {
    const d = Buffer.alloc(2 + 1 + objName.length + 1 + 1 + 1 + propName.length);
    let off = 0;
    d.writeUInt16BE(objType, off); off += 2;
    d[off++] = objName.length;
    Buffer.from(objName.toUpperCase(), 'ascii').copy(d, off); off += objName.length;
    d[off++] = flags;
    d[off++] = security;
    d[off++] = propName.length;
    Buffer.from(propName.toUpperCase(), 'ascii').copy(d, off);
    const r = await this._binderyCall(BIND_SUB.CREATE_PROPERTY, d);
    if (!r.ok) throw this._err(r, 'createProperty');
  }

  async readPropertyValue(objName, objType, propName, segment = 1) {
    const d = Buffer.alloc(2 + 1 + objName.length + 1 + 1 + propName.length);
    let off = 0;
    d.writeUInt16BE(objType, off); off += 2;
    d[off++] = objName.length;
    Buffer.from(objName.toUpperCase(), 'ascii').copy(d, off); off += objName.length;
    d[off++] = segment;
    d[off++] = propName.length;
    Buffer.from(propName.toUpperCase(), 'ascii').copy(d, off);
    const r = await this._binderyCall(BIND_SUB.READ_PROPERTY_VALUE, d);
    if (!r.ok) throw this._err(r, 'readPropertyValue');
    return { value: r.data.slice(0, 128), moreSegments: r.data[128] !== 0, flags: r.data[129] };
  }

  async writePropertyValue(objName, objType, propName, value, segment = 1, erase = 0) {
    const val = Buffer.alloc(128, 0);
    Buffer.from(value).copy(val);
    const d = Buffer.alloc(2 + 1 + objName.length + 1 + 1 + 1 + propName.length + 128);
    let off = 0;
    d.writeUInt16BE(objType, off); off += 2;
    d[off++] = objName.length;
    Buffer.from(objName.toUpperCase(), 'ascii').copy(d, off); off += objName.length;
    d[off++] = segment; d[off++] = erase;
    d[off++] = propName.length;
    Buffer.from(propName.toUpperCase(), 'ascii').copy(d, off); off += propName.length;
    val.copy(d, off);
    const r = await this._binderyCall(BIND_SUB.WRITE_PROPERTY_VALUE, d);
    if (!r.ok) throw this._err(r, 'writePropertyValue');
  }

  async changePassword(objName, objType, newPassword) {
    const d = Buffer.alloc(2 + 1 + objName.length + 1 + newPassword.length);
    let off = 0;
    d.writeUInt16BE(objType, off); off += 2;
    d[off++] = objName.length;
    Buffer.from(objName.toUpperCase(), 'ascii').copy(d, off); off += objName.length;
    d[off++] = newPassword.length;
    Buffer.from(newPassword, 'ascii').copy(d, off);
    const r = await this._binderyCall(BIND_SUB.CHANGE_PASSWORD, d);
    if (!r.ok) throw this._err(r, 'changePassword');
  }

  async verifyPassword(objName, objType, password) {
    const d = Buffer.alloc(2 + 1 + objName.length + 1 + password.length);
    let off = 0;
    d.writeUInt16BE(objType, off); off += 2;
    d[off++] = objName.length;
    Buffer.from(objName.toUpperCase(), 'ascii').copy(d, off); off += objName.length;
    d[off++] = password.length;
    Buffer.from(password, 'ascii').copy(d, off);
    const r = await this._binderyCall(BIND_SUB.VERIFY_PASSWORD, d);
    return r.ok;
  }

  // ---- Semaphores (nwXxx in NWSema.PAS) -----------------------------------

  async openSema(name, initialValue = 0) {
    const d = Buffer.alloc(2 + name.length);
    d.writeInt8(initialValue, 0);
    d[1] = name.length;
    Buffer.from(name, 'ascii').copy(d, 2);
    const r = await this._semaCall(SEMA_SUB.OPEN, d);
    if (!r.ok && r.completion !== 0) throw this._err(r, 'openSema');
    return { handle: r.data.readUInt32BE(0), openCount: r.data[4] };
  }

  async examineSema(handle) {
    const d = Buffer.alloc(4);
    d.writeUInt32BE(handle, 0);
    const r = await this._semaCall(SEMA_SUB.EXAMINE, d);
    if (!r.ok) throw this._err(r, 'examineSema');
    return { value: r.data.readInt16BE(0), openCount: r.data[2] };
  }

  async waitSema(handle, timeoutTicks = 0) {
    const d = Buffer.alloc(6);
    d.writeUInt32BE(handle, 0);
    d.writeUInt16BE(timeoutTicks, 4);
    const r = await this._semaCall(SEMA_SUB.WAIT, d);
    return r.ok;
  }

  async signalSema(handle) {
    const d = Buffer.alloc(4);
    d.writeUInt32BE(handle, 0);
    const r = await this._semaCall(SEMA_SUB.SIGNAL, d);
    return r.ok;
  }

  async closeSema(handle) {
    const d = Buffer.alloc(4);
    d.writeUInt32BE(handle, 0);
    const r = await this._semaCall(SEMA_SUB.CLOSE, d);
    return r.ok;
  }

  // ---- TTS (nwTTSXxx in NWTts.PAS) ----------------------------------------

  async ttsAvailable()         { const r = await this._ttsCall(TTS_SUB.AVAILABLE);     return r.completion === 0xFF; }
  async ttsBegin()             { const r = await this._ttsCall(TTS_SUB.BEGIN);         return r.ok; }
  async ttsEnd()               { const r = await this._ttsCall(TTS_SUB.END);           return r.ok ? r.data.readUInt32BE(0) : null; }
  async ttsAbort(id) {
    const d = Buffer.alloc(4); d.writeUInt32BE(id, 0);
    const r = await this._ttsCall(TTS_SUB.ABORT, d); return r.ok;
  }
  async ttsIsCommitted(id) {
    const d = Buffer.alloc(4); d.writeUInt32BE(id, 0);
    const r = await this._ttsCall(TTS_SUB.IS_COMMITTED, d); return r.ok;
  }
  async ttsEnable()  { const r = await this._ttsCall(TTS_SUB.ENABLE);  return r.ok; }
  async ttsDisable() { const r = await this._ttsCall(TTS_SUB.DISABLE); return r.ok; }

  // ---- Broadcast (nwXxx in NWMsg.PAS) -------------------------------------

  async sendBroadcast(connNos, message) {
    // connNos is an array of connection numbers
    const msgBuf = Buffer.from(message.slice(0, 58), 'ascii');
    const d = Buffer.alloc(1 + connNos.length * 2 + 1 + msgBuf.length);
    let off = 0;
    d[off++] = connNos.length;
    for (const c of connNos) { d.writeUInt16BE(c, off); off += 2; }
    d[off++] = msgBuf.length;
    msgBuf.copy(d, off);
    const r = await this._call(NCP_FUNC.BROADCAST, Buffer.concat([Buffer.from([BCAST_SUB.SEND_MESSAGE]), d]));
    return r.ok;
  }

  async getBroadcastMessage() {
    const r = await this._call(NCP_FUNC.BROADCAST, Buffer.from([BCAST_SUB.GET_MESSAGE]));
    if (!r.ok || r.data.length === 0) return null;
    const len = r.data[0];
    return r.data.slice(1, 1 + len).toString('ascii');
  }

  async getBroadcastMode() {
    const r = await this._call(NCP_FUNC.BROADCAST, Buffer.from([BCAST_SUB.GET_BCAST_MODE]));
    return r.ok ? r.data[0] : null;
  }

  async enableBroadcast()  {
    await this._call(NCP_FUNC.BROADCAST, Buffer.from([BCAST_SUB.ENABLE_BCAST]));
  }
  async disableBroadcast() {
    await this._call(NCP_FUNC.BROADCAST, Buffer.from([BCAST_SUB.DISABLE_BCAST]));
  }

  // ---- Error helper --------------------------------------------------------
  _err(reply, fn) {
    const code = `0x${reply.completion.toString(16).padStart(2,'0')}`;
    return Object.assign(new Error(`NCP ${fn} failed: completion=${code}`), { completion: reply.completion });
  }
}

module.exports = { NCPClient, OBJ_TYPE };
