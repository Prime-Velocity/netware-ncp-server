#!/usr/bin/env node
'use strict';
/**
 * demo-github.js  --  GitHub-backed NetWare demo
 *
 * With a real GitHub token:
 *   GH_TOKEN=ghp_xxx GH_OWNER=bclark00 node demo-github.js
 *
 * Without a token it runs against a mock GitHub backend so you can see
 * the full NCP stack exercising the volume API.
 */

const { GitHubVolume } = require('./nw-github-volume');
const { NCPFileService } = require('./nw-file-service');
const { NCPServer } = require('./ncp-server');
const { NCPClient, OBJ_TYPE } = require('./ncp-client');

const SEP = '='.repeat(62);
const pass = (l) => console.log(`  PASS  ${l}`);
const fail = (l, e) => console.log(`  FAIL  ${l}: ${e.message}`);

// ---- Mock GitHub API for offline demo ------------------------------------

function mockGitHubVolume(name) {
  const fs = new Map(); // path -> { content: Buffer, sha: string }
  const vol = {
    name,
    _fhs  : new Map(),
    _next : 1,

    async init() {
      console.log(`[MOCK-VOL] Volume ${name} ready (in-memory mock)`);
    },

    async listDir(path) {
      const prefix = path ? path + '/' : '';
      const seen = new Set();
      const out  = [];
      for (const [k, v] of fs) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const seg  = rest.split('/')[0];
        if (seen.has(seg)) continue;
        seen.add(seg);
        const isDir = rest.includes('/');
        out.push({ name: seg, isDir, size: isDir ? 0 : v.content.length });
      }
      return out;
    },

    async openFile(path, mode) {
      const existing = fs.get(path);
      if (!(mode & 0x10) && !existing) throw Object.assign(new Error(`Not found: ${path}`), { ncpCode: 0xFF });
      const fh = vol._next++;
      vol._fhs.set(fh, {
        path, pos: 0,
        sha  : existing ? existing.sha : null,
        buf  : existing ? Buffer.from(existing.content) : Buffer.alloc(0),
        dirty: false,
      });
      return fh;
    },

    async readFile(fh, count) {
      const f = vol._fhs.get(fh);
      const s = f.buf.slice(f.pos, f.pos + count);
      f.pos += s.length;
      return s;
    },

    async writeFile(fh, data) {
      const f = vol._fhs.get(fh);
      const end = f.pos + data.length;
      if (end > f.buf.length) {
        const nb = Buffer.alloc(end); f.buf.copy(nb); f.buf = nb;
      }
      data.copy(f.buf, f.pos); f.pos += data.length; f.dirty = true;
      return data.length;
    },

    async seekFile(fh, offset, whence) {
      const f = vol._fhs.get(fh);
      if      (whence === 0) f.pos = offset;
      else if (whence === 1) f.pos += offset;
      else if (whence === 2) f.pos = f.buf.length + offset;
      return f.pos;
    },

    async closeFile(fh) {
      const f = vol._fhs.get(fh);
      if (f.dirty) {
        const sha = 'mock-' + Math.random().toString(36).slice(2, 10);
        fs.set(f.path, { content: Buffer.from(f.buf), sha });
        console.log(`[MOCK-VOL] Committed: ${f.path} (${f.buf.length} bytes) sha=${sha}`);
        f.dirty = false;
      }
      vol._fhs.delete(fh);
    },

    async deleteFile(path) {
      if (!fs.has(path)) throw Object.assign(new Error(`Not found: ${path}`), { ncpCode: 0xFF });
      fs.delete(path);
      console.log(`[MOCK-VOL] Deleted: ${path}`);
    },

    async renameFile(old_, new_) {
      const v = fs.get(old_);
      if (!v) throw Object.assign(new Error(`Not found: ${old_}`), { ncpCode: 0xFF });
      fs.set(new_, v); fs.delete(old_);
      console.log(`[MOCK-VOL] Renamed: ${old_} -> ${new_}`);
    },

    async getFileInfo(path) {
      const v = fs.get(path);
      return v ? { size: v.content.length, sha: v.sha, attributes: 0 } : null;
    },

    beginTransaction()       { return Math.floor(Math.random() * 9000) + 1000; },
    async endTransaction(id) { console.log(`[MOCK-VOL] TTS commit txn=${id} (merged branch)`); },
    async abortTransaction(id){ console.log(`[MOCK-VOL] TTS abort txn=${id} (deleted branch)`); },
    attachToTransaction()    {},
  };
  return vol;
}

// ---- Build the stack -------------------------------------------------------

async function main() {
  const token = process.env.GH_TOKEN;
  const owner = process.env.GH_OWNER || 'bclark00';

  console.log(SEP);
  console.log('  GitHub-Backed NetWare -- Node.js');
  console.log('  Volumes are repos. Files are commits. TTS is branches.');
  if (token) {
    console.log(`  LIVE mode: github.com/${owner}/netware-sys`);
  } else {
    console.log('  DRY RUN mode (set GH_TOKEN + GH_OWNER for live GitHub)');
  }
  console.log(SEP);

  // ---- Build volumes -------------------------------------------------------
  let sysVol, dataVol;

  if (token) {
    sysVol  = new GitHubVolume(token, owner, 'netware-sys',  'SYS');
    dataVol = new GitHubVolume(token, owner, 'netware-data', 'DATA');
    await sysVol.init();
    await dataVol.init();
  } else {
    sysVol  = mockGitHubVolume('SYS');
    dataVol = mockGitHubVolume('DATA');
    await sysVol.init();
    await dataVol.init();
  }

  const volumes = new Map([['SYS', sysVol], ['DATA', dataVol]]);
  const fileSvc = new NCPFileService(volumes);

  // ---- Start NCP server with file service ----------------------------------
  const server = new NCPServer(5242, '127.0.0.1', { fileService: fileSvc });
  await server.start();
  const client = new NCPClient('127.0.0.1', 5242);
  const conn   = await client.connect();

  console.log(`\n[1] Connected: connLo=0x${conn.connLo.toString(16)} bufSize=${conn.bufferSize}`);
  pass('NCP handshake');

  // ---- Bindery: create a user in the GitHub-backed server ------------------
  console.log('\n[2] Bindery operations (in-memory, GitHub-backed TTS)');
  const uid = await client.createObject('BCLARK', OBJ_TYPE.USER);
  pass(`Created user BCLARK id=${uid}`);

  // ---- File operations via GitHub volume -----------------------------------
  console.log('\n[3] File write to SYS volume (-> GitHub commit)');
  const content = Buffer.from(
    `# Hello from 1993\n\nThis file was written via NCP.\n` +
    `Timestamp: ${new Date().toISOString()}\n` +
    `Connection: ${conn.connLo}\n`,
    'utf8'
  );

  const wFH = await fileSvc.handle(0x4C, 0, encodeFilePath('SYS:PUBLIC/HELLO.TXT', 0x10), conn.connLo);
  if (wFH.err !== 0) { fail('create file', new Error(`err=0x${wFH.err.toString(16)}`)); }
  else {
    const fhNum = wFH.reply.readUInt16LE(2);
    const wReq  = Buffer.alloc(12 + content.length);
    wFH.reply.copy(wReq, 0, 0, 6);
    wReq.writeUInt32LE(0, 6);
    wReq.writeUInt16LE(content.length, 10);
    content.copy(wReq, 12);
    await fileSvc.handle(0x4F, 0, wReq, conn.connLo);

    const closeReq = Buffer.alloc(6);
    wFH.reply.copy(closeReq, 0, 0, 6);
    await fileSvc.handle(0x42, 0, closeReq, conn.connLo);
    pass(`Wrote SYS:PUBLIC/HELLO.TXT (${content.length} bytes) -> GitHub commit`);
  }

  // ---- Read it back --------------------------------------------------------
  console.log('\n[4] Read file back');
  const oFH = await fileSvc.handle(0x48, 0, encodeFilePath('SYS:PUBLIC/HELLO.TXT', 0), conn.connLo);
  if (oFH.err !== 0) { fail('open for read', new Error(`err=0x${oFH.err.toString(16)}`)); }
  else {
    const rReq = Buffer.alloc(12);
    oFH.reply.copy(rReq, 0, 0, 6);
    rReq.writeUInt32LE(0, 6);
    rReq.writeUInt16LE(content.length, 10);
    const rReply = await fileSvc.handle(0x4E, 0, rReq, conn.connLo);
    const readLen = rReply.reply.readUInt16LE(0);
    const readBuf = rReply.reply.slice(2, 2 + readLen);
    if (readBuf.toString() === content.toString()) pass(`Read back ${readLen} bytes, content matches`);
    else fail('content round-trip', new Error('mismatch'));
    const cr = Buffer.alloc(6); oFH.reply.copy(cr, 0, 0, 6);
    await fileSvc.handle(0x42, 0, cr, conn.connLo);
  }

  // ---- Directory listing ---------------------------------------------------
  console.log('\n[5] Directory listing SYS:PUBLIC');
  const dirReply = await fileSvc.handle(0x53, 0, encodeFilePath('SYS:PUBLIC', 0), conn.connLo);
  if (dirReply.err !== 0) { fail('dir search', new Error(`err=0x${dirReply.err.toString(16)}`)); }
  else {
    const count = dirReply.reply.readUInt16LE(0);
    let off = 2;
    for (let i = 0; i < count; i++) {
      const type    = dirReply.reply[off++];
      const size    = dirReply.reply.readUInt32LE(off); off += 4;
      const nameLen = dirReply.reply[off++];
      const name    = dirReply.reply.slice(off, off + nameLen).toString('ascii'); off += nameLen;
      pass(`  ${type === 0x10 ? 'DIR ' : 'FILE'} ${name.padEnd(20)} ${size} bytes`);
    }
  }

  // ---- TTS: write on a branch, commit ---------------------------------
  console.log('\n[6] TTS transaction (GitHub branch -> merge)');
  const txnId = sysVol.beginTransaction();
  pass(`TTS Begin -> txnId=${txnId} (created GitHub branch ncp-txn-${txnId}-...)`);

  const txnContent = Buffer.from(`transactional write\ntxnId=${txnId}\n`, 'utf8');
  const tFH = await fileSvc.handle(0x4C, 0, encodeFilePath('SYS:DATA/TXN.LOG', 0x10), conn.connLo);
  if (tFH.err === 0) {
    sysVol.attachToTransaction(tFH.reply.readUInt16LE(2), txnId);
    const tw = Buffer.alloc(12 + txnContent.length);
    tFH.reply.copy(tw, 0, 0, 6);
    tw.writeUInt32LE(0, 6); tw.writeUInt16LE(txnContent.length, 10);
    txnContent.copy(tw, 12);
    await fileSvc.handle(0x4F, 0, tw, conn.connLo);
    const tc = Buffer.alloc(6); tFH.reply.copy(tc, 0, 0, 6);
    await fileSvc.handle(0x42, 0, tc, conn.connLo);
  }
  await sysVol.endTransaction(txnId);
  pass(`TTS Commit -> merged branch to main (every write is now a GitHub commit)`);

  // ---- Broadcast (still works, it's NCP) ----------------------------------
  console.log('\n[7] Broadcast (NCP protocol layer)');
  const connId = conn.connLo | (conn.connHi << 8);
  await client.sendBroadcast([connId], 'Your NetWare volume is on GitHub. Welcome to the future.');
  const msg = await client.getBroadcastMessage();
  if (msg) pass(`Broadcast: "${msg}"`);

  // ---- Done ----------------------------------------------------------------
  await client.disconnect();
  server.stop();

  console.log('\n' + SEP);
  if (token) {
    console.log(`  Done. Check github.com/${owner}/netware-sys for your commits.`);
  } else {
    console.log('  Done. Run with GH_TOKEN=... GH_OWNER=... to commit to real GitHub.');
  }
  console.log('  NetWare 3.12 + GitHub API. The 90s called. We answered.');
  console.log(SEP);
}

// ---- helpers ---------------------------------------------------------------

function encodeFilePath(path, mode) {
  // [1] nameLen [n] path [1] mode
  const buf = Buffer.alloc(1 + path.length + 1);
  buf[0] = path.length;
  Buffer.from(path, 'ascii').copy(buf, 1);
  buf[1 + path.length] = mode;
  return buf;
}

main().catch(e => { console.error('\nFATAL:', e.message, e.stack); process.exit(1); });
