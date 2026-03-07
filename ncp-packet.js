'use strict';
/**
 * ncp-packet.js  --  NetWare Core Protocol packet framing
 *
 * Ported from TurboPower BTF NWBase.PAS / NWConn.PAS
 *
 * NCP runs over IPX socket 0x0451.  We emulate it over UDP.
 * The IPX header is stripped; we speak pure NCP frames.
 *
 * NCP Request frame (from workstation):
 *   [0-1]  Request type  : 0x2222
 *   [2]    Sequence no   : 0x00..0xFF (wraps)
 *   [3]    Conn lo       : connection number low byte
 *   [4]    Task no       : task identifier
 *   [5]    Conn hi       : connection number high byte
 *   [6]    Function code : e.g. 0x17 = bindery, 0x20 = semaphore, 0x22 = TTS
 *   [7..n] Data
 *
 * NCP Reply frame (from server):
 *   [0-1]  Reply type    : 0x3333
 *   [2]    Sequence no   : echo of request sequence
 *   [3]    Conn lo
 *   [4]    Task no
 *   [5]    Conn hi
 *   [6]    Completion code : 0x00 = success
 *   [7]    Connection status : 0x00 = ok, 0x10 = server down
 *   [8..n] Reply data
 *
 * Burst-mode NCP (0x5555 / 0x7777) is not implemented — we only need
 * the classic request/reply cycle used by BTF.
 *
 * NCP "Create Service Connection" handshake (function 0x61):
 *   Request type 0x1111, body = max buffer size (word, big-endian)
 *   Reply type   0x3333, body = negotiated buffer size
 */

const REQUEST_TYPE    = 0x2222;
const REPLY_TYPE      = 0x3333;
const CONNECT_TYPE    = 0x1111;   // Create Service Connection
const DESTROY_TYPE    = 0x5555;   // Destroy Service Connection (type field)

const NCP_HEADER_LEN  = 7;   // request header bytes before data
const NCP_REPLY_HDR   = 8;   // reply header bytes before data

// NCP function codes (matches what BTF nwServerCall passes as Func)
const NCP_FUNC = {
  NEGOTIATE_BUFFER  : 0x61,  // Create Service Connection / negotiate buffer size
  FILE_SERVICES     : 0x0A,  // various file ops
  BINDERY           : 0x17,  // all bindery sub-functions
  SEMAPHORE         : 0x20,  // semaphore sub-functions
  TTS               : 0x22,  // Transaction Tracking System sub-functions
  GET_SERVER_TIME   : 0x14,  // actually sub of 0x17 but some impls use direct
  BROADCAST         : 0x21,  // message sub-functions
  LOGOUT            : 0x63,  // end session
};

// Bindery sub-function codes (first byte of data for func 0x17)
const BIND_SUB = {
  CREATE_OBJECT        : 0x32,
  DELETE_OBJECT        : 0x33,
  RENAME_OBJECT        : 0x34,
  GET_OBJECT_ID        : 0x35,
  GET_OBJECT_NAME      : 0x36,
  SCAN_OBJECT          : 0x37,
  CHANGE_OBJ_SECURITY  : 0x38,
  CREATE_PROPERTY      : 0x39,
  DELETE_PROPERTY      : 0x3A,
  CHANGE_PROP_SECURITY : 0x3B,
  SCAN_PROPERTY        : 0x3C,
  READ_PROPERTY_VALUE  : 0x3D,
  WRITE_PROPERTY_VALUE : 0x3E,
  VERIFY_PASSWORD      : 0x3F,
  CHANGE_PASSWORD      : 0x40,
  GET_BINDERY_ACCESS   : 0x46,
  OPEN_BINDERY         : 0x4C,
  CLOSE_BINDERY        : 0x4D,
  ADD_OBJ_TO_SET       : 0x41,
  DELETE_OBJ_FROM_SET  : 0x42,
  IS_OBJ_IN_SET        : 0x43,
  GET_CONN_INFO        : 0x16,
  GET_SERVER_INFO      : 0x11,
  GET_SERVER_TIME      : 0x14,
};

// Semaphore sub-function codes (first byte of data for func 0x20)
const SEMA_SUB = {
  OPEN    : 0x01,
  EXAMINE : 0x03,
  WAIT    : 0x02,   // decrement / WaitOnSemaphore
  SIGNAL  : 0x05,   // increment / SignalSemaphore
  CLOSE   : 0x04,
};

// TTS sub-function codes (first byte of data for func 0x22)
const TTS_SUB = {
  AVAILABLE    : 0x00,
  BEGIN        : 0x01,
  END          : 0x02,
  ABORT        : 0x03,
  IS_COMMITTED : 0x04,
  GET_APP_THRESH : 0x05,
  SET_APP_THRESH : 0x06,
  GET_WS_THRESH  : 0x07,
  SET_WS_THRESH  : 0x08,
  DISABLE      : 0xFE,
  ENABLE       : 0xFF,
};

// Broadcast sub-function codes (func 0x21)
const BCAST_SUB = {
  SEND_MESSAGE     : 0x00,
  GET_MESSAGE      : 0x01,
  DISABLE_BCAST    : 0x02,
  ENABLE_BCAST     : 0x03,
  GET_BCAST_MODE   : 0x04,
};

// Bindery object types  (nwboXxx in NWBind.PAS)
const OBJ_TYPE = {
  UNKNOWN       : 0x0000,
  USER          : 0x0001,
  GROUP         : 0x0002,
  PRINT_QUEUE   : 0x0003,
  FILE_SERVER   : 0x0004,
  JOB_SERVER    : 0x0005,
  GATEWAY       : 0x0006,
  PRINT_SERVER  : 0x0007,
  ARCHIVE_QUEUE : 0x0008,
  ARCHIVE_SERVER: 0x0009,
  JOB_QUEUE     : 0x000A,
  WILD          : 0xFFFF,
};

// Error codes (nwErrXxx in NWBase.PAS)
const ERR = {
  SUCCESS            : 0x0000,
  DPMI               : 0x7F01,
  WRONG_VER          : 0x7F02,
  SHELL              : 0x7F03,
  MEMORY             : 0x7F04,
  INTR               : 0x7F05,
  BAD_DATA           : 0x7F06,
  TOO_MANY_CONNS     : 0x7F07,
  NO_MORE_CONNS      : 0x7F08,
  // Server-side NCP completion codes (0x89xx = server returned error)
  NO_SUCH_OBJECT     : 0x89FC,
  NO_SUCH_PROPERTY   : 0x89FB,
  NO_SUCH_SET        : 0x89FA,
  NO_SUCH_MEMBER     : 0x89EB,
  NO_ACCESS          : 0x8988,
  BINDERY_LOCKED     : 0x89EF,
  OBJECT_EXISTS      : 0x89EE,
  PROPERTY_EXISTS    : 0x89ED,
  BAD_PASSWORD       : 0x89DE,
  TTS_UNAVAILABLE    : 0x89FF,
  SEMA_OVERFLOW      : 0x8901,
  SEMA_TIMEOUT       : 0x897F,
  SEMA_INVALID_HDL   : 0x89FF,
  SERVER_FAILURE     : 0x8900,
};

// ---- Packet builders -------------------------------------------------------

function buildRequest(seq, connLo, connHi, task, func, data) {
  const dataLen = data ? data.length : 0;
  const buf = Buffer.alloc(NCP_HEADER_LEN + dataLen);
  buf.writeUInt16BE(REQUEST_TYPE, 0);
  buf[2] = seq & 0xFF;
  buf[3] = connLo & 0xFF;
  buf[4] = task & 0xFF;
  buf[5] = connHi & 0xFF;
  buf[6] = func & 0xFF;
  if (data) data.copy(buf, NCP_HEADER_LEN);
  return buf;
}

function buildConnectRequest() {
  // NCP "Create Service Connection" — request type 0x1111
  // Proposes max buffer size of 1024 bytes (big-endian word)
  const buf = Buffer.alloc(9);
  buf.writeUInt16BE(CONNECT_TYPE, 0);
  buf[2] = 0x00; // seq
  buf[3] = 0xFF; // conn lo
  buf[4] = 0xFF; // task
  buf[5] = 0xFF; // conn hi
  buf[6] = 0x61; // func: Negotiate Buffer Size
  buf.writeUInt16BE(1024, 7); // proposed buffer size
  return buf;
}

function buildReply(seq, connLo, connHi, task, completion, data) {
  const dataLen = data ? data.length : 0;
  const buf = Buffer.alloc(NCP_REPLY_HDR + dataLen);
  buf.writeUInt16BE(REPLY_TYPE, 0);
  buf[2] = seq & 0xFF;
  buf[3] = connLo & 0xFF;
  buf[4] = task & 0xFF;
  buf[5] = connHi & 0xFF;
  buf[6] = completion & 0xFF;
  buf[7] = 0x00; // connection status ok
  if (data) data.copy(buf, NCP_REPLY_HDR);
  return buf;
}

// 0x5555 Destroy Service Connection packet
function buildDestroyRequest(seq, connLo, connHi, task) {
  const buf = Buffer.alloc(NCP_HEADER_LEN);
  buf.writeUInt16BE(DESTROY_TYPE, 0);
  buf[2] = seq    & 0xFF;
  buf[3] = connLo & 0xFF;
  buf[4] = task   & 0xFF;
  buf[5] = connHi & 0xFF;
  buf[6] = 0x00;
  buf[7] = 0x00;
  return buf;
}

// ---- Packet parsers --------------------------------------------------------

function parseRequest(buf) {
  if (buf.length < NCP_HEADER_LEN) return null;
  const type = buf.readUInt16BE(0);
  return {
    type,
    seq     : buf[2],
    connLo  : buf[3],
    task    : buf[4],
    connHi  : buf[5],
    func    : buf[6],
    data    : buf.slice(NCP_HEADER_LEN),
    isConnect: type === CONNECT_TYPE,
  };
}

function parseReply(buf) {
  if (buf.length < NCP_REPLY_HDR) return null;
  return {
    type       : buf.readUInt16BE(0),
    seq        : buf[2],
    connLo     : buf[3],
    task       : buf[4],
    connHi     : buf[5],
    completion : buf[6],
    connStatus : buf[7],
    data       : buf.slice(NCP_REPLY_HDR),
    ok         : buf[6] === 0 && buf[7] === 0,
  };
}

// ---- Wire helpers ----------------------------------------------------------

// NetWare uses big-endian for multi-byte values in NCP (opposite of x86 native)
// nwSwapLong in NWBase.PAS was the inline asm that handled this

function netLong(n) {
  // 32-bit big-endian Buffer
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function netWord(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xFFFF, 0);
  return b;
}

function readNetLong(buf, offset = 0) {
  return buf.readUInt32BE(offset);
}

function readNetWord(buf, offset = 0) {
  return buf.readUInt16BE(offset);
}

// Pascal-style length-prefixed string to/from Buffer
function encodePStr(str, maxLen = 47) {
  const s = str.slice(0, maxLen);
  const b = Buffer.alloc(s.length + 1);
  b[0] = s.length;
  Buffer.from(s, 'ascii').copy(b, 1);
  return b;
}

function decodePStr(buf, offset = 0) {
  const len = buf[offset];
  return buf.slice(offset + 1, offset + 1 + len).toString('ascii');
}

// NUL-terminated string (ASCIIZ) used for some NCP fields
function encodeAsciiz(str, maxLen = 48) {
  const s = str.slice(0, maxLen - 1);
  const b = Buffer.alloc(s.length + 1, 0);
  Buffer.from(s, 'ascii').copy(b);
  return b;
}

function decodeAsciiz(buf, offset = 0) {
  const end = buf.indexOf(0, offset);
  return buf.slice(offset, end === -1 ? buf.length : end).toString('ascii');
}

// ---- IPX address formatting (nwIPXAddressStr from NWBase.PAS) -------------
function ipxAddrStr(network, node, socket) {
  // wwwwwwww:nnnnnnnnnnnn:ssss
  const net = network.toString(16).padStart(8, '0');
  const nd  = Buffer.from(node).toString('hex').padStart(12, '0');
  const sk  = socket.toString(16).padStart(4, '0');
  return `${net}:${nd}:${sk}`;
}

module.exports = {
  REQUEST_TYPE, REPLY_TYPE, CONNECT_TYPE,
  NCP_FUNC, BIND_SUB, SEMA_SUB, TTS_SUB, BCAST_SUB, OBJ_TYPE, ERR,
  buildRequest, buildConnectRequest, buildReply, buildDestroyRequest,
  parseRequest, parseReply,
  netLong, netWord, readNetLong, readNetWord,
  encodePStr, decodePStr, encodeAsciiz, decodeAsciiz,
  ipxAddrStr,
};
