// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
//
// nw-sap.js -- NetWare Service Advertising Protocol (SAP) broadcaster
//
// Sends periodic IPX SAP broadcasts so DOS clients can run SLIST and
// discover this server without knowing its IP address in advance.
//
// Protocol: IPX socket 0x0452, UDP via ipxrelay-tap.js
//   SAP Operation 0x0002 = General Service Response (broadcast every 60s)
//   SAP Operation 0x0004 = Nearest Service Response (reply to 0x0003 queries)
//   Server Type 0x0004   = File Server
//   NCP Socket   0x0451
//
// SAP Entry layout (64 bytes per server):
//   [0-1]   Server Type   (BE)
//   [2-49]  Server Name   (48 bytes, null-padded)
//   [50-53] Network       (4 bytes)
//   [54-59] Node          (6 bytes = PackedIP: host LE u32 + port LE u16)
//   [60-61] Socket        (2 bytes BE) = 0x0451
//   [62-63] Hops          (2 bytes BE) = 1
//
// Usage:
//   const { SAPServer } = require('./nw-sap');
//   const sap = new SAPServer({ serverName: 'GENESIS', relayPort: 213 });
//   await sap.start();
//   sap.stop();

'use strict';
const dgram = require('dgram');
const os    = require('os');

const SAP_SOCKET      = 0x0452;
const NCP_SOCKET      = 0x0451;
const REG_SOCKET      = 0x0002;
const SAP_INTERVAL_MS = 60_000;
const SAP_ENTRY_SIZE  = 64;
const IPX_HDR         = 30;
const BCAST_HOST      = 0xffffffff;

const SAP_OP = {
  QUERY:   0x0001,
  RESPONSE:0x0002,
  NEAREST_QUERY:   0x0003,
  NEAREST_RESPONSE:0x0004,
};

const SERVER_TYPE = {
  FILE_SERVER:   0x0004,
  PRINT_SERVER:  0x0007,
  WILD:          0xFFFF,
};

// ---- IP helpers (SDL_net PackedIP = LE u32 host, LE u16 port)
function ip4ToLE(s) {
  const b = s.split('.').map(Number);
  return (b[0] | (b[1]<<8) | (b[2]<<16) | (b[3]<<24)) >>> 0;
}
function ip4FromLE(h) {
  return [h&0xFF,(h>>8)&0xFF,(h>>16)&0xFF,(h>>24)&0xFF].join('.');
}

// ---- Build IPX header (30 bytes)
// checkSum/length/socket: SDLNet_Write16 = BE
// PackedIP host/port: LE (x86 struct layout)
function buildIPXHdr(srcHost, srcPort, dstHost, dstPort, dstSock, srcSock, payloadLen) {
  const b = Buffer.alloc(IPX_HDR);
  b.writeUInt16BE(0xffff, 0);                         // checkSum
  b.writeUInt16BE(IPX_HDR + payloadLen, 2);            // length
  b[4] = 0;                                            // transControl
  b[5] = 0;                                            // pType
  // dst
  b.writeUInt32BE(0, 6);                               // dest.network
  b.writeUInt32LE(dstHost >>> 0, 10);                  // dest.host (LE)
  b.writeUInt16LE(dstPort, 14);                        // dest.port (LE)
  b.writeUInt16BE(dstSock, 16);                        // dest.socket (BE)
  // src
  b.writeUInt32BE(1, 18);                              // src.network = 1 (our net)
  b.writeUInt32LE(srcHost >>> 0, 22);                  // src.host (LE)
  b.writeUInt16LE(srcPort, 26);                        // src.port (LE)
  b.writeUInt16BE(srcSock, 28);                        // src.socket (BE)
  return b;
}

function buildRegPacket() {
  const b = Buffer.alloc(IPX_HDR);
  b.writeUInt16BE(0xffff, 0);
  b.writeUInt16BE(IPX_HDR, 2);
  b[4] = 0; b[5] = 0;
  b.writeUInt32BE(0, 6);  b.writeUInt32LE(0, 10); b.writeUInt16LE(0, 14); b.writeUInt16BE(REG_SOCKET, 16);
  b.writeUInt32BE(0, 18); b.writeUInt32LE(0, 22); b.writeUInt16LE(0, 26); b.writeUInt16BE(REG_SOCKET, 28);
  return b;
}

function parseIPXHdr(buf) {
  if (buf.length < IPX_HDR) return null;
  return {
    checkSum: buf.readUInt16BE(0),
    length:   buf.readUInt16BE(2),
    dst: {
      host: buf.readUInt32LE(10) >>> 0,
      port: buf.readUInt16LE(14),
      sock: buf.readUInt16BE(16),
    },
    src: {
      host: buf.readUInt32LE(22) >>> 0,
      port: buf.readUInt16LE(26),
      sock: buf.readUInt16BE(28),
    },
    payload: buf.slice(IPX_HDR),
  };
}

// ---- SAP entry (64 bytes)
function buildSAPEntry(serverName, serverType, network, nodeHost, nodePort, socket, hops = 1) {
  const b = Buffer.alloc(SAP_ENTRY_SIZE, 0);
  b.writeUInt16BE(serverType, 0);
  // Name: up to 47 chars, null-terminated, padded
  const nameBytes = Buffer.from(serverName.toUpperCase().slice(0, 47), 'ascii');
  nameBytes.copy(b, 2);
  b[2 + 47] = 0;                                       // ensure null terminator
  // Network (4 bytes)
  b.writeUInt32BE(network >>> 0, 50);
  // Node: PackedIP (host LE u32, port LE u16 = 6 bytes total)
  b.writeUInt32LE(nodeHost >>> 0, 54);
  b.writeUInt16LE(nodePort, 58);
  // Socket (BE)
  b.writeUInt16BE(socket, 60);
  // Hops (BE)
  b.writeUInt16BE(hops, 62);
  return b;
}

function buildSAPPacket(operation, entries) {
  const payload = Buffer.alloc(2 + entries.length * SAP_ENTRY_SIZE);
  payload.writeUInt16BE(operation, 0);
  entries.forEach((e, i) => e.copy(payload, 2 + i * SAP_ENTRY_SIZE));
  return payload;
}

function parseSAPPacket(buf) {
  if (buf.length < 2) return null;
  const op = buf.readUInt16BE(0);
  const entries = [];
  for (let off = 2; off + SAP_ENTRY_SIZE <= buf.length; off += SAP_ENTRY_SIZE) {
    const type = buf.readUInt16BE(off);
    const name = buf.slice(off+2, off+50).toString('ascii').replace(/\0.*$/, '');
    const net  = buf.readUInt32BE(off+50);
    const nodeHost = buf.readUInt32LE(off+54) >>> 0;
    const nodePort = buf.readUInt16LE(off+58);
    const sock = buf.readUInt16BE(off+60);
    const hops = buf.readUInt16BE(off+62);
    entries.push({ type, name, net, nodeHost, nodePort, sock, hops });
  }
  return { op, entries };
}

class SAPServer {
  constructor(opts = {}) {
    this._serverName  = opts.serverName  || 'GENESIS';
    this._serverType  = opts.serverType  || SERVER_TYPE.FILE_SERVER;
    this._network     = opts.network     || 1;
    this._relayHost   = opts.relayHost   || '127.0.0.1';
    this._relayPort   = opts.relayPort   || 213;
    this._ncpSocket   = opts.ncpSocket   || NCP_SOCKET;
    this._sock        = null;
    this._myHost      = 0;
    this._myPort      = 0;
    this._registered  = false;
    this._timer       = null;
    this._verbose     = opts.verbose !== false;
  }

  log(...args) { if (this._verbose) console.log('[SAP]', ...args); }

  start() {
    return new Promise((resolve, reject) => {
      this._sock = dgram.createSocket('udp4');

      this._sock.on('error', e => {
        console.error('[SAP] socket error:', e.message);
        reject(e);
      });

      this._sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));

      this._sock.bind(0, () => {
        this._myPort = this._sock.address().port;
        this._myHost = ip4ToLE(this._getLocalIP());
        this.log(`Bound :${this._myPort}, registering with relay ${this._relayHost}:${this._relayPort}`);
        // Register with relay
        this._sock.send(buildRegPacket(), this._relayPort, this._relayHost);
        // Wait for ACK then resolve
        const ackTimer = setTimeout(() => {
          // Register ok even without explicit ack confirmation (relay assigns by rinfo)
          this._registered = true;
          this.log(`Registered (timeout fallback)`);
          this._startBroadcasting();
          resolve(this);
        }, 500);

        this._pendingResolve = () => {
          clearTimeout(ackTimer);
          this._startBroadcasting();
          resolve(this);
        };
      });
    });
  }

  _getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const n of Object.keys(ifaces))
      for (const i of ifaces[n])
        if (!i.internal && i.family === 'IPv4') return i.address;
    return '127.0.0.1';
  }

  _onMessage(msg, rinfo) {
    const hdr = parseIPXHdr(msg);
    if (!hdr) return;

    // ACK from relay = dst.socket==REG_SOCKET addressed to us
    if (hdr.dst.sock === REG_SOCKET && !this._registered) {
      this._registered = true;
      this.log(`Registered with relay, node=${ip4FromLE(hdr.dst.host)}:${hdr.dst.port}`);
      if (this._pendingResolve) { this._pendingResolve(); this._pendingResolve = null; }
      return;
    }

    // SAP query on socket 0x0452
    if (hdr.dst.sock === SAP_SOCKET || hdr.dst.sock === SAP_SOCKET) {
      const sap = parseSAPPacket(hdr.payload);
      if (!sap) return;

      if (sap.op === SAP_OP.QUERY) {
        this.log(`SAP General Query from ${ip4FromLE(hdr.src.host)}:${hdr.src.port}`);
        this._sendSAP(hdr.src.host, hdr.src.port, SAP_OP.RESPONSE);
      } else if (sap.op === SAP_OP.NEAREST_QUERY) {
        this.log(`SAP Nearest Query from ${ip4FromLE(hdr.src.host)}:${hdr.src.port}`);
        this._sendSAP(hdr.src.host, hdr.src.port, SAP_OP.NEAREST_RESPONSE);
      }
    }
  }

  _buildEntry() {
    return buildSAPEntry(
      this._serverName,
      this._serverType,
      this._network,
      this._myHost,
      this._myPort,
      this._ncpSocket,
      1
    );
  }

  _sendSAP(dstHost, dstPort, operation) {
    const entry   = this._buildEntry();
    const payload = buildSAPPacket(operation, [entry]);
    const hdr     = buildIPXHdr(this._myHost, this._myPort, dstHost, dstPort,
                                SAP_SOCKET, SAP_SOCKET, payload.length);
    const pkt     = Buffer.concat([hdr, payload]);
    this._sock.send(pkt, this._relayPort, this._relayHost);
    this.log(`SAP op=0x${operation.toString(16)} -> ${ip4FromLE(dstHost)}:${dstPort} (${this._serverName})`);
  }

  _broadcast() {
    this._sendSAP(BCAST_HOST, 0, SAP_OP.RESPONSE);
  }

  _startBroadcasting() {
    // Immediate broadcast on startup, then every 60s
    this._broadcast();
    this._timer = setInterval(() => this._broadcast(), SAP_INTERVAL_MS);
    this._timer.unref();
    this.log(`Broadcasting every ${SAP_INTERVAL_MS/1000}s | server="${this._serverName}" type=0x${this._serverType.toString(16).padStart(4,'0')}`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._sock)  { try { this._sock.close(); } catch(_) {} this._sock = null; }
    this.log('Stopped');
  }

  // Update server name at runtime (e.g. to match bindery)
  setServerName(name) { this._serverName = name.toUpperCase().slice(0, 47); }

  // Trigger an immediate broadcast (e.g. after name change)
  announce() { if (this._registered) this._broadcast(); }
}

// ---- Exports
module.exports = { SAPServer, SERVER_TYPE, SAP_OP, SAP_SOCKET, NCP_SOCKET,
  buildSAPEntry, buildSAPPacket, parseSAPPacket };

// ---- Standalone mode
if (require.main === module) {
  const name = process.argv[2] || process.env.NCP_SERVER_NAME || 'GENESIS';
  const port = parseInt(process.env.RELAY_PORT || '213');
  const sap  = new SAPServer({ serverName: name, relayPort: port });

  sap.start().then(() => {
    console.log(`[SAP] Server "${name}" advertising on relay :${port}`);
    console.log('[SAP] DOS: SLIST should now show this server');
  }).catch(e => {
    console.error('[SAP] Fatal:', e.message);
    process.exit(1);
  });

  process.on('SIGINT', () => { sap.stop(); process.exit(0); });
}
