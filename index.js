// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * index.js  --  NetWare NCP server assembly point
 *
 * Wires NCPServer + NCPFileService + GitHubVolume(s) + SAPServer from environment:
 *
 *   GH_TOKEN          GitHub PAT with repo scope   (required for GitHub volume)
 *   GH_OWNER          GitHub user or org           (required for GitHub volume)
 *   GH_REPO           Repo name for SYS volume     (default: nw-vol-sys)
 *   NCP_PORT          UDP port to bind             (default: 524)
 *   NCP_HOST          IP to bind                   (default: 0.0.0.0)
 *   NCP_SERVER_NAME   NetWare server name          (default: GENESIS)
 *   SAP_RELAY_HOST    IPX relay host               (default: 127.0.0.1)
 *   SAP_RELAY_PORT    IPX relay port               (default: 213)
 *   SAP_DISABLED      Set to '1' to disable SAP    (default: off)
 *
 * Without GH_TOKEN / GH_OWNER, starts with Bindery, Semaphores, TTS,
 * Broadcast (in-memory only) -- no file service. Useful for testing.
 *
 * Usage:
 *   node index.js
 *
 * Programmatic:
 *   const { createServer } = require('.');
 *   const { server } = await createServer({ port: 5240 });
 */

const { NCPServer }      = require('./ncp-server');
const { NCPFileService } = require('./nw-file-service');
const { GitHubVolume }   = require('./nw-github-volume');
const { SAPServer }      = require('./nw-sap');

/**
 * Create and start an NCPServer + optional SAPServer.
 *
 * @param {object} opts
 * @param {string}  [opts.token]       GitHub PAT
 * @param {string}  [opts.owner]       GitHub user/org
 * @param {string}  [opts.repo]        Repo name for SYS volume
 * @param {number}  [opts.port]        NCP UDP port (default 524)
 * @param {string}  [opts.host]        Bind host (default 0.0.0.0)
 * @param {string}  [opts.serverName]  NetWare server name (default GENESIS)
 * @param {string}  [opts.sapHost]     IPX relay host for SAP (default 127.0.0.1)
 * @param {number}  [opts.sapPort]     IPX relay port for SAP (default 213)
 * @param {boolean} [opts.sapDisabled] Disable SAP broadcaster (default false)
 * @param {Map}     [opts.volumes]     Pre-built Map<name, GitHubVolume>
 * @returns {Promise<{server: NCPServer, sap: SAPServer|null}>}
 */
async function createServer(opts = {}) {
  const token      = opts.token      || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const owner      = opts.owner      || process.env.GH_OWNER;
  const repo       = opts.repo       || process.env.GH_REPO       || 'nw-vol-sys';
  const port       = opts.port       || parseInt(process.env.NCP_PORT       || '524');
  const host       = opts.host       || process.env.NCP_HOST       || '0.0.0.0';
  const serverName = opts.serverName || process.env.NCP_SERVER_NAME || 'GENESIS';
  const sapHost    = opts.sapHost    || process.env.SAP_RELAY_HOST  || '127.0.0.1';
  const sapPort    = opts.sapPort    || parseInt(process.env.SAP_RELAY_PORT  || '213');
  const sapDisabled= opts.sapDisabled || process.env.SAP_DISABLED === '1';

  // Assemble volumes
  let volumes = opts.volumes || null;
  if (!volumes && token && owner) {
    volumes = new Map();
    const sys = new GitHubVolume(token, owner, repo, 'SYS');
    await sys.init();
    volumes.set('SYS', sys);
    console.log(`[NCP] GitHub volume: ${owner}/${repo} -> SYS`);
  }

  if (!volumes || volumes.size === 0) {
    console.log('[NCP] No GitHub volume configured -- file service disabled');
    console.log('[NCP] Set GH_TOKEN and GH_OWNER to enable GitHub-backed volumes');
  }

  // Start NCP server
  const fileSvc = volumes && volumes.size > 0 ? new NCPFileService(volumes) : null;
  const server  = new NCPServer(port, host, { fileService: fileSvc });
  await server.start();

  // Register server name in bindery
  try {
    server.bindery.handle(0x32, buildServerObj(serverName));
  } catch(_) {}

  // Start SAP broadcaster
  let sap = null;
  if (!sapDisabled) {
    sap = new SAPServer({
      serverName,
      relayHost: sapHost,
      relayPort: sapPort,
      verbose:   true,
    });
    try {
      await sap.start();
      console.log(`[NCP] SAP advertising "${serverName}" via relay ${sapHost}:${sapPort}`);
      console.log('[NCP] DOS: run SLIST to discover this server');
    } catch(e) {
      console.warn(`[NCP] SAP failed to start: ${e.message} (continuing without SAP)`);
      sap = null;
    }
  } else {
    console.log('[NCP] SAP disabled (SAP_DISABLED=1)');
  }

  return { server, sap };
}

// Build minimal CREATE_OBJECT payload for FILE_SERVER bindery object
function buildServerObj(name) {
  // Sub 0x32: type(2BE) + flags(1) + security(1) + name(pascal str)
  const n = Buffer.from(name.toUpperCase().slice(0, 47), 'ascii');
  const b = Buffer.alloc(5 + n.length);
  b.writeUInt16BE(0x0004, 0); // type = FILE_SERVER
  b[2] = 0x00;                // flags
  b[3] = 0x31;                // security (read: any, write: super)
  b[4] = n.length;            // pascal length
  n.copy(b, 5);
  return b;
}

// ---- CLI entry point -------------------------------------------------------

if (require.main === module) {
  createServer().then(({ server, sap }) => {
    const shutdown = () => {
      console.log('\n[NCP] Stopping...');
      server.stop();
      if (sap) sap.stop();
      process.exit(0);
    };
    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(e => {
    console.error('[NCP] Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { createServer };
