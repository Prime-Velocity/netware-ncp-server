// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * ncp-webhook-client.js  --  GitHub-webhook-driven NCP client gateway
 *
 * A Genesis Civilian issues an NCP filesystem or informational request by
 * posting a structured JSON payload in a GitHub issue body or issue comment.
 * This server receives the GitHub webhook, validates it, dispatches the
 * operation through NCPClient, and posts the result back as a comment.
 *
 * Transport model:
 *
 *   Genesis Civilian
 *       |
 *       | GitHub issue / comment  (JSON NCP request)
 *       v
 *   GitHub Webhooks  -->  POST /webhook  (this server)
 *       |
 *       | NCPClient (UDP/NCP to target host)
 *       v
 *   NCP Server (netware-ncp-server)
 *       |
 *       | result
 *       v
 *   GitHub API  -->  comment on issue  (result posted back)
 *       |
 *       v
 *   Genesis Civilian reads response
 *
 * Request format (in issue body or comment):
 *
 *   ```ncp
 *   {
 *     "op":   "listDir",
 *     "args": { "path": "SYS/PUBLIC" },
 *     "host": "10.27.1.155",          // optional — overrides default
 *     "port": 524,                     // optional
 *     "nonce": "abc123"                // optional — echoed in response
 *   }
 *   ```
 *
 * Supported ops:
 *   getServerInfo, getServerTime,
 *   listDir, readFile, writeFile, deleteFile, renameFile, getFileInfo,
 *   createObject, deleteObject, getObjectID, getObjectName, scanObjects,
 *   createProperty, readPropertyValue, writePropertyValue,
 *   openSema, examineSema, waitSema, signalSema, closeSema,
 *   ttsAvailable, ttsBegin, ttsEnd, ttsAbort, ttsIsCommitted,
 *   sendBroadcast, getBroadcastMessage
 *
 * Environment variables:
 *   NCP_HOST           default NCP server host        (required)
 *   NCP_PORT           default NCP server port        (default 524)
 *   GITHUB_TOKEN       PAT for posting comments       (required)
 *   GITHUB_OWNER       repo owner for posting results (required)
 *   GITHUB_REPO        repo name  for posting results (required)
 *   WEBHOOK_SECRET     GitHub webhook secret          (required)
 *   PORT               HTTP listen port               (default 3000)
 *   ALLOWED_CIVILIANS  comma-separated GitHub logins allowed to issue requests
 *                      (empty = allow any sender — set this in production)
 */

const http    = require('http');
const crypto  = require('crypto');
const https   = require('https');
const { NCPClient, OBJ_TYPE } = require('./ncp-client');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
  ncpHost          : process.env.NCP_HOST || '127.0.0.1',
  ncpPort          : parseInt(process.env.NCP_PORT || '524', 10),
  githubToken      : process.env.GITHUB_TOKEN || '',
  githubOwner      : process.env.GITHUB_OWNER || '',
  githubRepo       : process.env.GITHUB_REPO  || '',
  webhookSecret    : process.env.WEBHOOK_SECRET || '',
  port             : parseInt(process.env.PORT || '3000', 10),
  allowedCivilians : (process.env.ALLOWED_CIVILIANS || '')
                       .split(',').map(s => s.trim()).filter(Boolean),
};

// ---------------------------------------------------------------------------
// Request extraction  (parse ```ncp ... ``` fenced blocks from markdown)
// ---------------------------------------------------------------------------

const NCP_FENCE_RE = /```ncp\s*([\s\S]*?)```/g;

function extractRequests(body) {
  if (!body) return [];
  const requests = [];
  let m;
  NCP_FENCE_RE.lastIndex = 0;
  while ((m = NCP_FENCE_RE.exec(body)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed.op === 'string') requests.push(parsed);
    } catch (e) {
      requests.push({ _parseError: e.message, _raw: m[1] });
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// NCP dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a single NCP request object against the target host.
 * Returns a plain-object result (JSON-serializable).
 */
async function dispatch(req) {
  const host = req.host || CONFIG.ncpHost;
  const port = req.port || CONFIG.ncpPort;
  const client = new NCPClient(host, port);

  // File-service operations are routed through the GitHub volume via the
  // server's NCP file-service handler (func 0x0A).  The NCPClient has no
  // direct file-service methods — those live on the server side.  For the
  // webhook client we proxy them as Bindery property reads/writes using a
  // well-known convention, OR we use a direct file-service extension when
  // present.  See inline comments per operation.

  try {
    await client.connect();
    let result;

    switch (req.op) {

      // ---- Server info / time -------------------------------------------
      case 'getServerInfo':
        result = await client.getServerInfo();
        break;

      case 'getServerTime':
        result = await client.getServerTime();
        break;

      // ---- File service --------------------------------------------------
      // These are thin pass-throughs to the NCP file-service handler.
      // The server is expected to support NCP func 0x0A sub-functions.

      case 'listDir': {
        const path = req.args?.path || '';
        result = await fileServiceCall(client, 'LIST_DIR', { path });
        break;
      }

      case 'readFile': {
        const { path, offset = 0, count = 4096 } = req.args || {};
        if (!path) throw new Error('readFile: args.path required');
        result = await fileServiceCall(client, 'READ_FILE', { path, offset, count });
        break;
      }

      case 'writeFile': {
        const { path, content, encoding = 'utf8' } = req.args || {};
        if (!path)    throw new Error('writeFile: args.path required');
        if (content == null) throw new Error('writeFile: args.content required');
        const buf = Buffer.from(content, encoding);
        result = await fileServiceCall(client, 'WRITE_FILE', { path, content: buf.toString('base64') });
        break;
      }

      case 'deleteFile': {
        const { path } = req.args || {};
        if (!path) throw new Error('deleteFile: args.path required');
        result = await fileServiceCall(client, 'DELETE_FILE', { path });
        break;
      }

      case 'renameFile': {
        const { oldPath, newPath } = req.args || {};
        if (!oldPath || !newPath) throw new Error('renameFile: args.oldPath and newPath required');
        result = await fileServiceCall(client, 'RENAME_FILE', { oldPath, newPath });
        break;
      }

      case 'getFileInfo': {
        const { path } = req.args || {};
        if (!path) throw new Error('getFileInfo: args.path required');
        result = await fileServiceCall(client, 'GET_FILE_INFO', { path });
        break;
      }

      // ---- Bindery -------------------------------------------------------
      case 'createObject': {
        const { name, type = OBJ_TYPE.USER, flags, security } = req.args || {};
        if (!name) throw new Error('createObject: args.name required');
        result = { id: await client.createObject(name, type, flags, security) };
        break;
      }

      case 'deleteObject': {
        const { name, type = OBJ_TYPE.USER } = req.args || {};
        if (!name) throw new Error('deleteObject: args.name required');
        await client.deleteObject(name, type);
        result = { deleted: name };
        break;
      }

      case 'getObjectID': {
        const { name, type = OBJ_TYPE.USER } = req.args || {};
        if (!name) throw new Error('getObjectID: args.name required');
        result = await client.getObjectID(name, type);
        break;
      }

      case 'getObjectName': {
        const { id } = req.args || {};
        if (id == null) throw new Error('getObjectName: args.id required');
        result = await client.getObjectName(id);
        break;
      }

      case 'scanObjects': {
        const { pattern = '*', type = OBJ_TYPE.WILD } = req.args || {};
        result = await client.scanObjects(pattern, type);
        break;
      }

      case 'createProperty': {
        const { objName, objType = OBJ_TYPE.USER, propName, flags, security } = req.args || {};
        if (!objName || !propName) throw new Error('createProperty: args.objName and propName required');
        await client.createProperty(objName, objType, propName, flags, security);
        result = { created: propName };
        break;
      }

      case 'readPropertyValue': {
        const { objName, objType = OBJ_TYPE.USER, propName, segment = 1 } = req.args || {};
        if (!objName || !propName) throw new Error('readPropertyValue: args.objName and propName required');
        const r = await client.readPropertyValue(objName, objType, propName, segment);
        result = {
          value        : r.value.toString('base64'),
          moreSegments : r.moreSegments,
          flags        : r.flags,
        };
        break;
      }

      case 'writePropertyValue': {
        const { objName, objType = OBJ_TYPE.USER, propName, value, encoding = 'utf8', segment = 1, erase = 0 } = req.args || {};
        if (!objName || !propName || value == null) throw new Error('writePropertyValue: objName, propName, value required');
        const buf = Buffer.from(value, encoding);
        await client.writePropertyValue(objName, objType, propName, buf, segment, erase);
        result = { written: propName };
        break;
      }

      // ---- Semaphores ----------------------------------------------------
      case 'openSema': {
        const { name, initialValue = 0 } = req.args || {};
        if (!name) throw new Error('openSema: args.name required');
        result = await client.openSema(name, initialValue);
        break;
      }

      case 'examineSema': {
        const { handle } = req.args || {};
        if (handle == null) throw new Error('examineSema: args.handle required');
        result = await client.examineSema(handle);
        break;
      }

      case 'waitSema': {
        const { handle, timeoutTicks = 0 } = req.args || {};
        if (handle == null) throw new Error('waitSema: args.handle required');
        result = { acquired: await client.waitSema(handle, timeoutTicks) };
        break;
      }

      case 'signalSema': {
        const { handle } = req.args || {};
        if (handle == null) throw new Error('signalSema: args.handle required');
        result = { signaled: await client.signalSema(handle) };
        break;
      }

      case 'closeSema': {
        const { handle } = req.args || {};
        if (handle == null) throw new Error('closeSema: args.handle required');
        result = { closed: await client.closeSema(handle) };
        break;
      }

      // ---- TTS -----------------------------------------------------------
      case 'ttsAvailable':
        result = { available: await client.ttsAvailable() };
        break;

      case 'ttsBegin':
        result = { begun: await client.ttsBegin() };
        break;

      case 'ttsEnd': {
        const txnId = await client.ttsEnd();
        result = { txnId };
        break;
      }

      case 'ttsAbort': {
        const { txnId } = req.args || {};
        if (txnId == null) throw new Error('ttsAbort: args.txnId required');
        result = { aborted: await client.ttsAbort(txnId) };
        break;
      }

      case 'ttsIsCommitted': {
        const { txnId } = req.args || {};
        if (txnId == null) throw new Error('ttsIsCommitted: args.txnId required');
        result = { committed: await client.ttsIsCommitted(txnId) };
        break;
      }

      // ---- Broadcast messaging -------------------------------------------
      case 'sendBroadcast': {
        const { connNos, message } = req.args || {};
        if (!Array.isArray(connNos) || !message) throw new Error('sendBroadcast: args.connNos[] and message required');
        result = { sent: await client.sendBroadcast(connNos, message) };
        break;
      }

      case 'getBroadcastMessage':
        result = { message: await client.getBroadcastMessage() };
        break;

      default:
        throw new Error(`Unknown NCP operation: ${req.op}`);
    }

    await client.disconnect().catch(() => {});
    return { ok: true, op: req.op, nonce: req.nonce, result };

  } catch (err) {
    try { await client.disconnect(); } catch (_) {}
    return { ok: false, op: req.op, nonce: req.nonce, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// File-service sub-protocol
//
// The base NCPClient only covers Bindery/Semaphore/TTS/Broadcast.
// File operations are dispatched via a thin JSON-over-NCP-property convention:
// we write the request JSON to property "FS_REQ" on a transient bindery
// object, poll for "FS_RES", and clean up.  This works with the reference
// ncp-server's file-service handler that also implements this side-channel.
//
// Alternatively, if the target server exposes a sidecar HTTP REST API on
// port 5080 (ncp-server --http), we use that instead for simplicity.
// ---------------------------------------------------------------------------

async function fileServiceCall(client, op, args) {
  // Prefer HTTP sidecar if configured
  const sidecarHost = CONFIG.ncpHost;
  const sidecarPort = 5080;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ op, args });
    const options = {
      hostname : sidecarHost,
      port     : sidecarPort,
      path     : '/fs',
      method   : 'POST',
      headers  : {
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(body),
        'X-NCP-Token'    : CONFIG.githubToken,
      },
    };
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) reject(new Error(json.error || `HTTP ${res.statusCode}`));
          else resolve(json);
        } catch (e) {
          reject(new Error(`File-service parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname : 'api.github.com',
      path,
      method,
      headers  : {
        'Authorization' : `token ${CONFIG.githubToken}`,
        'User-Agent'    : 'ncp-webhook-client/1.0',
        'Accept'        : 'application/vnd.github.v3+json',
        'Content-Type'  : 'application/json',
      },
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve({ status: res.statusCode, data: json });
        } catch (_) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function postComment(issueNumber, body) {
  const path = `/repos/${CONFIG.githubOwner}/${CONFIG.githubRepo}/issues/${issueNumber}/comments`;
  const r = await ghRequest('POST', path, { body });
  if (r.status >= 300) {
    console.error(`[GH] Failed to post comment: ${r.status}`, r.data);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function formatResponse(req, results) {
  const lines = [];
  const ts = new Date().toISOString();
  lines.push(`<!-- ncp-webhook-client response ${ts} -->`);
  lines.push('');
  lines.push('**NCP Gateway Response**');
  lines.push('');

  for (const res of results) {
    if (res._parseError) {
      lines.push('> **Parse error** in NCP request block:');
      lines.push(`> \`${res._parseError}\``);
      lines.push('');
      continue;
    }

    const label = res.nonce ? `\`${res.op}\` (nonce: \`${res.nonce}\`)` : `\`${res.op}\``;
    if (res.ok) {
      lines.push(`**${label}** — OK`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(res.result, null, 2));
      lines.push('```');
    } else {
      lines.push(`**${label}** — ERROR`);
      lines.push('');
      lines.push(`> ${res.error}`);
    }
    lines.push('');
  }

  lines.push(`*Host: \`${CONFIG.ncpHost}:${CONFIG.ncpPort}\` · Gateway: ncp-webhook-client*`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

function verifySignature(rawBody, sigHeader) {
  if (!CONFIG.webhookSecret) return true; // dev mode — no secret configured
  if (!sigHeader) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', CONFIG.webhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Civilian allowlist
// ---------------------------------------------------------------------------

function isCivilianAllowed(login) {
  if (!CONFIG.allowedCivilians.length) return true;
  return CONFIG.allowedCivilians.includes(login);
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(event, payload) {
  // We handle: issues (opened/edited), issue_comment (created/edited)
  let issueNumber = null;
  let body        = null;
  let sender      = null;

  if (event === 'issues' && ['opened', 'edited'].includes(payload.action)) {
    issueNumber = payload.issue.number;
    body        = payload.issue.body;
    sender      = payload.sender.login;
  } else if (event === 'issue_comment' && ['created', 'edited'].includes(payload.action)) {
    issueNumber = payload.issue.number;
    body        = payload.comment.body;
    sender      = payload.sender.login;
  } else {
    // Event we don't act on
    return;
  }

  if (!isCivilianAllowed(sender)) {
    console.log(`[WH] Ignoring request from non-civilian: ${sender}`);
    return;
  }

  const requests = extractRequests(body);
  if (!requests.length) return; // no NCP fences — not for us

  console.log(`[WH] #${issueNumber} from ${sender}: ${requests.length} NCP request(s)`);

  // Dispatch all requests (parallel)
  const results = await Promise.all(
    requests.map(req =>
      req._parseError
        ? Promise.resolve(req)
        : dispatch(req)
    )
  );

  // Post result as comment
  const comment = formatResponse({ issueNumber, sender }, results);
  await postComment(issueNumber, comment);
  console.log(`[WH] #${issueNumber} response posted`);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok       : true,
      ncpHost  : CONFIG.ncpHost,
      ncpPort  : CONFIG.ncpPort,
      repo     : `${CONFIG.githubOwner}/${CONFIG.githubRepo}`,
    }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end('Not found\n');
    return;
  }

  const rawBody = await readBody(req);
  const sig     = req.headers['x-hub-signature-256'];

  if (!verifySignature(rawBody, sig)) {
    console.warn('[WH] Invalid signature — rejected');
    res.writeHead(401);
    res.end('Invalid signature\n');
    return;
  }

  const event = req.headers['x-github-event'];
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    res.writeHead(400);
    res.end('Bad JSON\n');
    return;
  }

  // Acknowledge immediately (GitHub requires < 10 s)
  res.writeHead(202);
  res.end('Accepted\n');

  // Process async
  handleWebhook(event, payload).catch(e =>
    console.error('[WH] Handler error:', e.message)
  );
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function validateConfig() {
  const missing = [];
  if (!CONFIG.githubToken) missing.push('GITHUB_TOKEN');
  if (!CONFIG.githubOwner) missing.push('GITHUB_OWNER');
  if (!CONFIG.githubRepo)  missing.push('GITHUB_REPO');
  if (missing.length) {
    console.error(`[CFG] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!CONFIG.webhookSecret) {
    console.warn('[CFG] WEBHOOK_SECRET not set — signature verification disabled (dev mode)');
  }
  if (!CONFIG.allowedCivilians.length) {
    console.warn('[CFG] ALLOWED_CIVILIANS not set — accepting requests from any GitHub user');
  }
}

if (require.main === module) {
  validateConfig();
  server.listen(CONFIG.port, () => {
    console.log(`[NCP-WH] NetWare NCP webhook gateway listening on :${CONFIG.port}`);
    console.log(`[NCP-WH] NCP target: ${CONFIG.ncpHost}:${CONFIG.ncpPort}`);
    console.log(`[NCP-WH] GitHub repo: ${CONFIG.githubOwner}/${CONFIG.githubRepo}`);
    if (CONFIG.allowedCivilians.length) {
      console.log(`[NCP-WH] Allowed civilians: ${CONFIG.allowedCivilians.join(', ')}`);
    }
  });
}

module.exports = {
  // Exported for testing / embedding
  extractRequests,
  dispatch,
  handleWebhook,
  verifySignature,
  isCivilianAllowed,
  formatResponse,
  CONFIG,
};
