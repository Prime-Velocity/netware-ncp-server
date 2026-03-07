'use strict';
/**
 * nw-github-volume.js  --  GitHub-backed NetWare volume
 *
 * Maps NetWare file operations onto the GitHub Contents API.
 *
 *   NCP volume  = GitHub repo  (e.g. "bclark00/my-volume")
 *   NCP dir     = GitHub tree  (directory path in repo)
 *   NCP file    = GitHub blob  (file path in repo)
 *   NCP write   = GitHub commit (every write is a commit)
 *   NCP delete  = GitHub delete commit
 *   TTS begin   = open branch  (branch = txnId)
 *   TTS end     = merge PR     (squash merge to main)
 *   TTS abort   = delete branch
 *
 * Auth: pass a GitHub PAT with repo scope.
 *
 * Rate limits: GitHub allows 5000 req/hr authenticated.
 * For a toy NetWare server that's basically unlimited.
 */

const https = require('https');
const net   = require('net');

// ── Proxy tunnel agent (reads HTTPS_PROXY env, works in Claude containers) ──

function makeProxyAgent() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return undefined;
  try {
    // http://user:pass@host:port
    const m = raw.match(/^https?:\/\/([^@]+)@([^:]+):(\d+)/);
    if (!m) return undefined;
    const [, userPass, host, port] = m;
    const auth = Buffer.from(userPass).toString('base64');
    return { host, port: parseInt(port), auth };
  } catch { return undefined; }
}

const PROXY = makeProxyAgent();

function proxyRequest(opts, body) {
  return new Promise((resolve, reject) => {
    if (!PROXY) {
      // Direct connection
      const payload = body || null;
      const req = https.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, chunks, headers: res.headers }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
      return;
    }
    // CONNECT tunnel
    const tunnel = net.createConnection(PROXY.port, PROXY.host, () => {
      tunnel.write(
        'CONNECT ' + opts.hostname + ':443 HTTP/1.1\r\n' +
        'Host: ' + opts.hostname + ':443\r\n' +
        'Proxy-Authorization: Basic ' + PROXY.auth + '\r\n\r\n'
      );
      tunnel.once('data', () => {
        const req = https.request({ ...opts, socket: tunnel, agent: false }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, chunks, headers: res.headers }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    });
    tunnel.on('error', reject);
  });
}

// ---- tiny GitHub API client -----------------------------------------------

class GitHubAPI {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo  = repo;
    this.base  = `/repos/${owner}/${repo}`;
  }

  _req(method, path, body) {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname : 'api.github.com',
      path,
      method,
      headers  : {
        'Authorization' : `token ${this.token}`,
        'User-Agent'    : 'nw-github-volume/1.0 (NetWare 3.12 compatible)',
        'Accept'        : 'application/vnd.github.v3+json',
        'Content-Type'  : 'application/json',
      },
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

    return proxyRequest(opts, payload).then(({ status, chunks }) => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = text; }
      if (status >= 400) {
        const msg = json && json.message ? json.message : text;
        const err = new Error(`GitHub ${method} ${path} -> ${status}: ${msg}`);
        err.status = status;
        err.github = json;
        throw err;
      }
      return { status, data: json };
    });
  }

  get(path)         { return this._req('GET',    path); }
  post(path, body)  { return this._req('POST',   path, body); }
  put(path, body)   { return this._req('PUT',    path, body); }
  delete(path,body) { return this._req('DELETE', path, body); }

  // ---- high-level helpers --------------------------------------------------

  async getFile(filePath, ref = 'main') {
    // Returns { content: Buffer, sha: string } or null if not found
    try {
      const r = await this.get(
        `${this.base}/contents/${encodeURIPath(filePath)}?ref=${ref}`
      );
      const content = Buffer.from(r.data.content.replace(/\n/g,''), 'base64');
      return { content, sha: r.data.sha, size: r.data.size };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async writeFile(filePath, content, message, sha = null, branch = 'main') {
    // content = Buffer or string
    const b64 = Buffer.isBuffer(content)
      ? content.toString('base64')
      : Buffer.from(content).toString('base64');
    const body = { message, content: b64, branch };
    if (sha) body.sha = sha;
    const r = await this.put(
      `${this.base}/contents/${encodeURIPath(filePath)}`,
      body
    );
    return { sha: r.data.content.sha, commitSha: r.data.commit.sha };
  }

  async deleteFile(filePath, message, sha, branch = 'main') {
    const r = await this.delete(
      `${this.base}/contents/${encodeURIPath(filePath)}`,
      { message, sha, branch }
    );
    return r.data.commit.sha;
  }

  async listDir(dirPath, ref = 'main') {
    // Returns array of { name, type('file'|'dir'), sha, size }
    try {
      const p = dirPath ? `${this.base}/contents/${encodeURIPath(dirPath)}?ref=${ref}`
                        : `${this.base}/contents?ref=${ref}`;
      const r = await this.get(p);
      if (!Array.isArray(r.data)) return []; // single file
      return r.data.map(e => ({
        name : e.name,
        type : e.type === 'dir' ? 'dir' : 'file',
        sha  : e.sha,
        size : e.size || 0,
      }));
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // ---- branch operations (for TTS) ----------------------------------------

  async getRef(ref = 'heads/main') {
    const r = await this.get(`${this.base}/git/refs/${ref}`);
    return r.data.object.sha;
  }

  async createBranch(branchName) {
    const sha = await this.getRef('heads/main');
    await this.post(`${this.base}/git/refs`, {
      ref : `refs/heads/${branchName}`,
      sha,
    });
    return branchName;
  }

  async deleteBranch(branchName) {
    try {
      await this.delete(`${this.base}/git/refs/heads/${branchName}`);
    } catch (_) {}
  }

  async mergeBranch(branchName, message) {
    // Merge branchName -> main
    await this.post(`${this.base}/merges`, {
      base    : 'main',
      head    : branchName,
      commit_message: message,
    });
    await this.deleteBranch(branchName);
  }

  // ---- repo bootstrap -----------------------------------------------------

  async ensureRepo() {
    try {
      await this.get(`/repos/${this.owner}/${this.repo}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      // Create repo
      await this.post('/user/repos', {
        name        : this.repo,
        description : 'NetWare volume backed by GitHub (circa 1993)',
        private     : true,
        auto_init   : true,
      });
      console.log(`[GH-VOL] Created repo ${this.owner}/${this.repo}`);
    }
  }
}

function encodeURIPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// ---- NW volume interface ---------------------------------------------------

class GitHubVolume {
  /**
   * @param {string} token   GitHub PAT
   * @param {string} owner   GitHub user/org
   * @param {string} repo    repo name  (= volume name on the wire)
   * @param {string} name    NCP volume label (e.g. "SYS", "DATA")
   */
  constructor(token, owner, repo, name) {
    this.name   = name.toUpperCase();
    this.gh     = new GitHubAPI(token, owner, repo);
    this._fhs   = new Map();   // fileHandle -> { path, pos, sha, buf, branch, dirty }
    this._nextFH = 1;
    // In-flight TTS transactions: txnId -> branchName
    this._txns  = new Map();
    this._nextTxn = 100;
  }

  async init() {
    await this.gh.ensureRepo();
    console.log(`[GH-VOL] Volume ${this.name} -> ${this.gh.owner}/${this.gh.repo} ready`);
  }

  // ---- Directory operations -----------------------------------------------

  async listDir(path) {
    // path = '' for root, 'SYS/PUBLIC' for subdir
    const entries = await this.gh.listDir(path);
    if (!entries) return null;
    return entries.map(e => ({
      name       : e.name,
      isDir      : e.type === 'dir',
      size       : e.size,
      attributes : 0x00,
    }));
  }

  // ---- File open/read/write/close -----------------------------------------

  async openFile(path, mode) {
    // mode: 0=read, 1=write, 2=rdwr, 0x10=create
    const creating = !!(mode & 0x10);
    const existing = await this.gh.getFile(path);

    if (!creating && !existing) {
      throw ncpErr(0xFF, `File not found: ${path}`);
    }

    const fh = this._nextFH++;
    this._fhs.set(fh, {
      path    : path,
      pos     : 0,
      sha     : existing ? existing.sha : null,
      buf     : existing ? existing.content : Buffer.alloc(0),
      dirty   : false,
      branch  : 'main',
    });
    return fh;
  }

  async readFile(fh, count) {
    const f = this._getFH(fh);
    const slice = f.buf.slice(f.pos, f.pos + count);
    f.pos += slice.length;
    return slice;
  }

  async writeFile(fh, data) {
    const f = this._getFH(fh);
    // Expand buffer if needed
    const end = f.pos + data.length;
    if (end > f.buf.length) {
      const nb = Buffer.alloc(end);
      f.buf.copy(nb);
      f.buf = nb;
    }
    data.copy(f.buf, f.pos);
    f.pos  += data.length;
    f.dirty = true;
    return data.length;
  }

  async seekFile(fh, offset, whence) {
    const f = this._getFH(fh);
    if      (whence === 0) f.pos = offset;
    else if (whence === 1) f.pos = f.pos + offset;
    else if (whence === 2) f.pos = f.buf.length + offset;
    f.pos = Math.max(0, f.pos);
    return f.pos;
  }

  async closeFile(fh) {
    const f = this._getFH(fh);
    if (f.dirty) {
      const msg = `[NetWare] write ${f.path} via NCP`;
      const result = await this.gh.writeFile(
        f.path, f.buf, msg, f.sha, f.branch
      );
      f.sha   = result.sha;
      f.dirty = false;
      console.log(`[GH-VOL] Committed: ${f.path} (${f.buf.length} bytes) sha=${result.sha.slice(0,8)}`);
    }
    this._fhs.delete(fh);
  }

  async deleteFile(path) {
    const existing = await this.gh.getFile(path);
    if (!existing) throw ncpErr(0xFF, `File not found: ${path}`);
    await this.gh.deleteFile(path, `[NetWare] delete ${path} via NCP`, existing.sha);
    console.log(`[GH-VOL] Deleted: ${path}`);
  }

  async renameFile(oldPath, newPath) {
    // GitHub has no rename — copy+delete
    const existing = await this.gh.getFile(oldPath);
    if (!existing) throw ncpErr(0xFF, `File not found: ${oldPath}`);
    await this.gh.writeFile(newPath, existing.content,
      `[NetWare] rename ${oldPath} -> ${newPath} via NCP`, null);
    await this.gh.deleteFile(oldPath,
      `[NetWare] rename cleanup ${oldPath}`, existing.sha);
    console.log(`[GH-VOL] Renamed: ${oldPath} -> ${newPath}`);
  }

  async getFileInfo(path) {
    const f = await this.gh.getFile(path);
    if (!f) return null;
    return { size: f.size, sha: f.sha, attributes: 0x00 };
  }

  // ---- TTS integration (branch per transaction) ---------------------------

  beginTransaction() {
    const txnId = this._nextTxn++;
    const branch = `ncp-txn-${txnId}-${Date.now()}`;
    this._txns.set(txnId, branch);
    // async fire-and-forget branch creation
    this.gh.createBranch(branch).catch(e =>
      console.error(`[GH-VOL] createBranch failed:`, e.message)
    );
    console.log(`[GH-VOL] TTS begin -> branch ${branch}`);
    return txnId;
  }

  async endTransaction(txnId) {
    const branch = this._txns.get(txnId);
    if (!branch) return;
    // flush any open FHs on this branch first
    for (const [fh, f] of this._fhs) {
      if (f.branch === branch) await this.closeFile(fh);
    }
    await this.gh.mergeBranch(branch, `[NetWare] TTS commit txn=${txnId}`);
    this._txns.delete(txnId);
    console.log(`[GH-VOL] TTS end -> merged branch ${branch}`);
  }

  async abortTransaction(txnId) {
    const branch = this._txns.get(txnId);
    if (!branch) return;
    // discard open FHs on this branch
    for (const [fh, f] of this._fhs) {
      if (f.branch === branch) { f.dirty = false; this._fhs.delete(fh); }
    }
    await this.gh.deleteBranch(branch);
    this._txns.delete(txnId);
    console.log(`[GH-VOL] TTS abort -> deleted branch ${branch}`);
  }

  // Associate an open file handle with the current TTS branch
  attachToTransaction(fh, txnId) {
    const f = this._getFH(fh);
    const branch = this._txns.get(txnId);
    if (branch) f.branch = branch;
  }

  // ---- internal -----------------------------------------------------------

  _getFH(fh) {
    const f = this._fhs.get(fh);
    if (!f) throw ncpErr(0xFF, `Invalid file handle: ${fh}`);
    return f;
  }
}

function ncpErr(code, msg) {
  const e = new Error(msg);
  e.ncpCode = code;
  return e;
}

module.exports = { GitHubVolume, GitHubAPI };
