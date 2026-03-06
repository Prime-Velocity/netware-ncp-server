// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * index.js  --  NetWare NCP server assembly point
 *
 * Wires NCPServer + NCPFileService + GitHubVolume(s) from environment:
 *
 *   GH_TOKEN   GitHub PAT with repo scope   (required for GitHub volume)
 *   GH_OWNER   GitHub user or org           (required for GitHub volume)
 *   GH_REPO    Repo name for SYS volume     (default: nw-vol-sys)
 *   NCP_PORT   UDP port to bind             (default: 524)
 *   NCP_HOST   IP to bind                   (default: 0.0.0.0)
 *
 * Without GH_TOKEN / GH_OWNER, the server starts with Bindery, Semaphores,
 * TTS (in-memory), and Broadcast — but no file service. Useful for testing.
 *
 * Usage:
 *   node index.js
 *
 * Programmatic:
 *   const { createServer } = require('.');
 *   const server = await createServer({ port: 5240 });  // non-root port for tests
 *   await server.stop();
 */

const { NCPServer }      = require('./ncp-server');
const { NCPFileService } = require('./nw-file-service');
const { GitHubVolume }   = require('./nw-github-volume');

/**
 * Create and start an NCPServer, optionally with a GitHub-backed volume.
 *
 * @param {object} opts
 * @param {string}  [opts.token]     GitHub PAT (overrides GH_TOKEN env)
 * @param {string}  [opts.owner]     GitHub user/org (overrides GH_OWNER env)
 * @param {string}  [opts.repo]      Repo name for SYS volume (overrides GH_REPO env)
 * @param {number}  [opts.port]      UDP port (overrides NCP_PORT env, default 524)
 * @param {string}  [opts.host]      Bind host (overrides NCP_HOST env, default 0.0.0.0)
 * @param {Map}     [opts.volumes]   Pre-built Map<name, GitHubVolume> (skips auto-create)
 * @returns {Promise<NCPServer>}
 */
async function createServer(opts = {}) {
  const token = opts.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const owner = opts.owner || process.env.GH_OWNER;
  const repo  = opts.repo  || process.env.GH_REPO  || 'nw-vol-sys';
  const port  = opts.port  || parseInt(process.env.NCP_PORT  || '524');
  const host  = opts.host  || process.env.NCP_HOST  || '0.0.0.0';

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
    console.log('[NCP] No GitHub volume configured — file service disabled');
    console.log('[NCP] Set GH_TOKEN and GH_OWNER to enable GitHub-backed volumes');
  }

  const fileSvc = volumes && volumes.size > 0 ? new NCPFileService(volumes) : null;
  const server  = new NCPServer(port, host, { fileService: fileSvc });
  await server.start();

  return server;
}

// ---- CLI entry point -------------------------------------------------------

if (require.main === module) {
  createServer().catch(e => {
    console.error('[NCP] Fatal:', e.message);
    process.exit(1);
  });

  process.on('SIGINT',  () => { console.log('\n[NCP] Stopping...'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\n[NCP] Stopping...'); process.exit(0); });
}

module.exports = { createServer };
