// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * nw-file-service.js  --  NCP File Service
 *
 * Implements NCP function codes for file I/O, plugged into NCPServer.
 * Backend: GitHubVolume (or any object with the same interface).
 *
 * NCP functions handled:
 *   0x48  Open File
 *   0x4C  Create File
 *   0x42  Close File
 *   0x48  Read File
 *   0x49  Write File
 *   0x4A  Delete File
 *   0x4F  Rename File
 *   0x4E  Search for Files (directory listing)
 *   0x17/0x16  Get Volume Info
 *   0x18  End of Job (flush open handles for connection)
 *
 * Wire format ported from NWBase.PAS / NWFile.PAS TnwFileHandle usage.
 *
 * File handle encoding:
 *   Bytes 0-1: volume index (uint16 LE)
 *   Bytes 2-3: fh within volume (uint16 LE)
 *   Bytes 4-5: reserved / connection id
 */

const NCP_FILE = {
  OPEN        : 0x48,
  CREATE      : 0x4C,
  CLOSE       : 0x42,
  READ        : 0x4E,
  WRITE       : 0x4F,
  DELETE      : 0x44,
  RENAME      : 0x4D,
  DIR_SEARCH  : 0x53,
  FILE_INFO   : 0x46,
  VOL_INFO    : 0x17,       // sub 0x16
};

const ERR_FILE_NOT_FOUND = 0xFF;
const ERR_SUCCESS        = 0x00;
const ERR_BAD_HANDLE     = 0x88;
const ERR_NO_PERMISSION  = 0x8C;

class NCPFileService {
  /**
   * @param {Map<string,GitHubVolume>} volumes  name -> GitHubVolume
   */
  constructor(volumes) {
    this._volumes = volumes;   // Map: volName -> GitHubVolume
    this._conns   = new Map(); // connId -> { openHandles: Set<string> }
  }

  // ---- volume helpers ------------------------------------------------------

  _vol(name) {
    return this._volumes.get(name.toUpperCase()) || null;
  }

  _firstVol() {
    return this._volumes.values().next().value || null;
  }

  // ---- NCP request dispatch ------------------------------------------------

  /**
   * Called by NCPServer for any unrecognised function.
   * Returns { err, reply } in the same shape as nw-bindery handlers.
   */
  async handle(func, subFunc, data, connId) {
    try {
      switch (func) {
        case NCP_FILE.OPEN:       return await this._openFile(data, connId);
        case NCP_FILE.CREATE:     return await this._createFile(data, connId);
        case NCP_FILE.CLOSE:      return await this._closeFile(data, connId);
        case NCP_FILE.READ:       return await this._readFile(data, connId);
        case NCP_FILE.WRITE:      return await this._writeFile(data, connId);
        case NCP_FILE.DELETE:     return await this._deleteFile(data, connId);
        case NCP_FILE.RENAME:     return await this._renameFile(data, connId);
        case NCP_FILE.DIR_SEARCH: return await this._dirSearch(data, connId);
        case NCP_FILE.FILE_INFO:  return await this._fileInfo(data, connId);
        default:
          return { err: 0xFB, reply: null }; // unknown request
      }
    } catch (e) {
      const code = e.ncpCode || 0xFF;
      console.error(`[FILE-SVC] Error func=0x${func.toString(16)}:`, e.message);
      return { err: code, reply: null };
    }
  }

  // ---- Open ----------------------------------------------------------------
  // Request: [1] nameLen [n] volName:path  [1] mode
  async _openFile(data, connId) {
    const { vol, path, mode } = this._parsePath(data, 0);
    const fh = await vol.openFile(path, mode);
    const info = await vol.getFileInfo(path);
    const reply = Buffer.alloc(6 + 4);
    this._encodeFH(vol, fh, reply, 0);
    reply.writeUInt32LE(info ? info.size : 0, 6);
    this._trackHandle(connId, vol.name, fh);
    console.log(`[FILE-SVC] OPEN ${vol.name}:${path} fh=${fh} mode=0x${mode.toString(16)}`);
    return { err: ERR_SUCCESS, reply };
  }

  // ---- Create --------------------------------------------------------------
  async _createFile(data, connId) {
    const { vol, path, mode } = this._parsePath(data, 0);
    const fh = await vol.openFile(path, 0x10 | mode);
    const reply = Buffer.alloc(10);
    this._encodeFH(vol, fh, reply, 0);
    this._trackHandle(connId, vol.name, fh);
    console.log(`[FILE-SVC] CREATE ${vol.name}:${path} fh=${fh}`);
    return { err: ERR_SUCCESS, reply };
  }

  // ---- Close ---------------------------------------------------------------
  // Request: [6] fileHandle
  async _closeFile(data, connId) {
    const { vol, fh } = this._decodeFH(data, 0);
    await vol.closeFile(fh);
    this._untrackHandle(connId, vol.name, fh);
    console.log(`[FILE-SVC] CLOSE fh=${fh}`);
    return { err: ERR_SUCCESS, reply: null };
  }

  // ---- Read ----------------------------------------------------------------
  // Request: [6] fh [4] offset [2] count
  async _readFile(data, connId) {
    const { vol, fh } = this._decodeFH(data, 0);
    const offset = data.readUInt32LE(6);
    const count  = data.readUInt16LE(10);
    await vol.seekFile(fh, offset, 0);
    const bytes = await vol.readFile(fh, count);
    const reply = Buffer.alloc(2 + bytes.length);
    reply.writeUInt16LE(bytes.length, 0);
    bytes.copy(reply, 2);
    console.log(`[FILE-SVC] READ fh=${fh} offset=${offset} req=${count} got=${bytes.length}`);
    return { err: ERR_SUCCESS, reply };
  }

  // ---- Write ---------------------------------------------------------------
  // Request: [6] fh [4] offset [2] count [n] data
  async _writeFile(data, connId) {
    const { vol, fh } = this._decodeFH(data, 0);
    const offset = data.readUInt32LE(6);
    const count  = data.readUInt16LE(10);
    const payload = data.slice(12, 12 + count);
    await vol.seekFile(fh, offset, 0);
    const written = await vol.writeFile(fh, payload);
    const reply = Buffer.alloc(4);
    reply.writeUInt32LE(written, 0);
    console.log(`[FILE-SVC] WRITE fh=${fh} offset=${offset} bytes=${written}`);
    return { err: ERR_SUCCESS, reply };
  }

  // ---- Delete --------------------------------------------------------------
  // Request: [1] nameLen [n] volName:path
  async _deleteFile(data, connId) {
    const { vol, path } = this._parsePath(data, 0);
    await vol.deleteFile(path);
    console.log(`[FILE-SVC] DELETE ${vol.name}:${path}`);
    return { err: ERR_SUCCESS, reply: null };
  }

  // ---- Rename --------------------------------------------------------------
  // Request: [1] nameLen [n] oldPath  [1] nameLen [n] newPath
  async _renameFile(data, connId) {
    const { vol, path: oldPath, nextOff } = this._parsePath(data, 0);
    const { path: newPath } = this._parsePath(data, nextOff);
    await vol.renameFile(oldPath, newPath);
    console.log(`[FILE-SVC] RENAME ${oldPath} -> ${newPath}`);
    return { err: ERR_SUCCESS, reply: null };
  }

  // ---- Directory search ----------------------------------------------------
  // Request: [1] nameLen [n] volName:path
  async _dirSearch(data, connId) {
    const { vol, path } = this._parsePath(data, 0);
    const entries = await vol.listDir(path);
    if (!entries) return { err: ERR_FILE_NOT_FOUND, reply: null };

    // Pack: [2] count then for each: [1] type [4] size [1] nameLen [n] name
    let len = 2;
    for (const e of entries) len += 1 + 4 + 1 + e.name.length;
    const reply = Buffer.alloc(len);
    reply.writeUInt16LE(entries.length, 0);
    let off = 2;
    for (const e of entries) {
      reply[off++] = e.isDir ? 0x10 : 0x00;
      reply.writeUInt32LE(e.size, off); off += 4;
      reply[off++] = e.name.length;
      Buffer.from(e.name, 'ascii').copy(reply, off); off += e.name.length;
    }
    console.log(`[FILE-SVC] DIR ${vol.name}:${path} -> ${entries.length} entries`);
    return { err: ERR_SUCCESS, reply };
  }

  // ---- File info -----------------------------------------------------------
  async _fileInfo(data, connId) {
    const { vol, path } = this._parsePath(data, 0);
    const info = await vol.getFileInfo(path);
    if (!info) return { err: ERR_FILE_NOT_FOUND, reply: null };
    const reply = Buffer.alloc(8);
    reply.writeUInt32LE(info.size, 0);
    reply.writeUInt32LE(0, 4); // attributes / reserved
    return { err: ERR_SUCCESS, reply };
  }

  // ---- Volume info (0x17 sub 0x16) -----------------------------------------
  async volumeInfo(subFunc, data) {
    if (subFunc !== 0x16) return { err: 0xFB, reply: null };
    const vol = this._firstVol();
    if (!vol) return { err: 0xFF, reply: null };
    // Reply: [16] volName, [4] totalBlocks, [4] freeBlocks, [4] totalDir, [4] freeDir
    const reply = Buffer.alloc(32);
    Buffer.from(vol.name.padEnd(16, '\0'), 'ascii').copy(reply, 0);
    reply.writeUInt32LE(999999, 16); // totalBlocks (unlimited — it's GitHub)
    reply.writeUInt32LE(999999, 20); // freeBlocks
    reply.writeUInt32LE(9999, 24);   // totalDir
    reply.writeUInt32LE(9999, 28);   // freeDir
    return { err: ERR_SUCCESS, reply };
  }

  // ---- connection cleanup --------------------------------------------------

  async endOfJob(connId) {
    const conn = this._conns.get(connId);
    if (!conn) return;
    for (const key of conn.openHandles) {
      const [volName, fhStr] = key.split(':');
      const vol = this._vol(volName);
      if (vol) {
        try { await vol.closeFile(parseInt(fhStr)); } catch (_) {}
      }
    }
    this._conns.delete(connId);
  }

  // ---- wire format helpers -------------------------------------------------

  _parsePath(data, off) {
    // [1] nameLen [n] "VOLNAME:path/to/file" [1] mode (optional)
    const nameLen = data[off]; off++;
    const raw     = data.slice(off, off + nameLen).toString('ascii');
    off += nameLen;
    const mode    = data[off] !== undefined ? data[off] : 0;
    const nextOff = off + 1;

    // Split "VOLNAME:path" or just "path" (use first volume)
    let volName, path;
    const colon = raw.indexOf(':');
    if (colon >= 0) {
      volName = raw.slice(0, colon).toUpperCase();
      path    = raw.slice(colon + 1).replace(/\\/g, '/').replace(/^\//, '');
    } else {
      volName = this._firstVol() ? this._firstVol().name : 'SYS';
      path    = raw.replace(/\\/g, '/').replace(/^\//, '');
    }

    const vol = this._vol(volName);
    if (!vol) throw Object.assign(new Error(`Unknown volume: ${volName}`), { ncpCode: 0x98 });
    return { vol, path, mode, nextOff };
  }

  _encodeFH(vol, fh, buf, off) {
    // 6-byte NW file handle: [2] volIndex [2] fh [2] 0x0000
    const volIdx = [...this._volumes.keys()].indexOf(vol.name);
    buf.writeUInt16LE(volIdx >= 0 ? volIdx : 0, off);
    buf.writeUInt16LE(fh, off + 2);
    buf.writeUInt16LE(0, off + 4);
  }

  _decodeFH(data, off) {
    const volIdx = data.readUInt16LE(off);
    const fh     = data.readUInt16LE(off + 2);
    const volName = [...this._volumes.keys()][volIdx];
    const vol    = this._vol(volName);
    if (!vol) throw Object.assign(new Error(`Bad vol index: ${volIdx}`), { ncpCode: ERR_BAD_HANDLE });
    return { vol, fh };
  }

  _trackHandle(connId, volName, fh) {
    if (!this._conns.has(connId)) this._conns.set(connId, { openHandles: new Set() });
    this._conns.get(connId).openHandles.add(`${volName}:${fh}`);
  }

  _untrackHandle(connId, volName, fh) {
    const conn = this._conns.get(connId);
    if (conn) conn.openHandles.delete(`${volName}:${fh}`);
  }
}

module.exports = { NCPFileService, NCP_FILE };
