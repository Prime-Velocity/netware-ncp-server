// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';

/**
 * nw-conduit-denormalizer.js
 *
 * Conduit denormalizer that emits canonical IR as NCP primitives via GitHubVolume.
 *
 * Uses NCP transaction semantics (TTS begin/commit/abort) over GitHubVolume
 * directly (in-process). Every IR write becomes a GitHub commit. Streams
 * become atomic branch + merge.
 *
 * IR type mapping:
 *   record / document → single file write (one commit)
 *   stream            → branch → N file writes → merge PR (atomic batch)
 *
 * Destination: { path, filename? }
 *   path     — directory path within volume (default: '/')
 *   filename — override filename (default: derived from ir.id)
 *
 * Config:
 *   token    — GitHub PAT (required)
 *   owner    — GitHub org/user (required)
 *   repo     — repo name (default: 'nw-vol-sys')
 *   volume   — volume name label (default: 'SYS')
 *   format   — 'json' | 'text' | 'raw' (default: 'json')
 *   tts      — use branch+merge for stream writes (default: true)
 */

const { NCPFileService } = require('./nw-file-service');
const { GitHubVolume }   = require('./nw-github-volume');

class NCPDenormalizer {
  constructor(volume) {
    // Accept a pre-built GitHubVolume or config to build one
    this._volume = volume || null;
  }

  async _getVolume(config) {
    if (this._volume) return this._volume;
    const { token, owner, repo = 'nw-vol-sys', volume: name = 'SYS' } = config;
    if (!token || !owner) throw new Error('NCPDenormalizer: token and owner required in config');
    const vol = new GitHubVolume(token, owner, repo, name);
    await vol.init();
    return vol;
  }

  /**
   * Main entry point — matches conduit BaseDenormalizer interface.
   */
  async denormalize(ir, destination = {}, config = {}) {
    const vol    = await this._getVolume(config);
    const format = config.format || 'json';
    const tts    = config.tts !== false;

    const { path = '/', filename = null } = destination;
    const content = ir.getContent();
    const type    = ir.data?.type || 'record';
    const results = [];

    if (type === 'stream' && Array.isArray(content)) {
      // Branch → write each element → merge (atomic)
      const txnId = `conduit-${ir.id}-${Date.now()}`;
      let branch  = null;

      if (tts) {
        branch = await vol.gh.createBranch(txnId);
      }

      try {
        for (let i = 0; i < content.length; i++) {
          const name    = filename
            ? `${filename}-${String(i).padStart(4, '0')}`
            : `${ir.id}-${String(i).padStart(4, '0')}`;
          const fpath   = `${path}/${name}`.replace('//', '/');
          const data    = this._serialize(content[i], format);
          const message = `conduit: write ${fpath} [${i + 1}/${content.length}] ir=${ir.id}`;
          const r       = await vol.gh.writeFile(fpath, data, message, null, branch || 'main');
          results.push({ index: i, path: fpath, sha: r.sha, commitSha: r.commitSha });
        }

        if (tts && branch) {
          await vol.gh.mergeBranch(branch, `conduit: commit stream ir=${ir.id} (${content.length} files)`);
        }
      } catch (err) {
        if (tts && branch) {
          await vol.gh.deleteBranch(branch).catch(() => {});
        }
        throw err;
      }

    } else {
      // Single file write → single commit
      const name  = filename || ir.id;
      const fpath = `${path}/${name}`.replace('//', '/');
      const data  = this._serialize(content, format);
      const msg   = `conduit: write ${fpath} ir=${ir.id} src=${ir.metadata?.sourceProtocol || 'unknown'}`;
      const r     = await vol.gh.writeFile(fpath, data, msg);
      results.push({ path: fpath, sha: r.sha, commitSha: r.commitSha });
    }

    return {
      data:     content,
      protocol: 'ncp',
      volume:   vol.name,
      repo:     vol.repo,
      owner:    vol.owner,
      files:    results,
      metadata: {
        protocol:        'ncp',
        volume:          vol.name,
        tts,
        sourceProtocol:  ir.metadata?.sourceProtocol,
        irId:            ir.id,
        transformations: ir.transformations?.length || 0,
      },
    };
  }

  /**
   * Read a file back from the volume.
   */
  async read(destination = {}, config = {}) {
    const vol  = await this._getVolume(config);
    const { path, filename } = destination;
    if (!path && !filename) throw new Error('destination.path or filename required');
    const fpath = filename ? `${path || '/'}/${filename}`.replace('//', '/') : path;
    return vol.gh.getFile(fpath);
  }

  /**
   * List a directory.
   */
  async list(destination = {}, config = {}) {
    const vol  = await this._getVolume(config);
    const { path = '/' } = destination;
    return vol.gh.listDir(path);
  }

  _serialize(content, format) {
    if (format === 'text') return String(content);
    if (format === 'raw')  return content;
    return JSON.stringify(content, null, 2);
  }
}

// Protocol tag for ProtocolDenormalizer.register()
NCPDenormalizer.protocol = 'ncp';

module.exports = { NCPDenormalizer };
