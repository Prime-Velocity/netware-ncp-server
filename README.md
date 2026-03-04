# NetWare NCP Server - Node.js Implementation

**2,361 lines of Novell NetWare Core Protocol (NCP) implementation with GitHub backend**

## What This Is

A complete NetWare 3.12-compatible NCP server that uses GitHub as the backing store.

- **NCP Server** over UDP port 524
- **GitHub as filesystem** (every write = commit, TTS = branches)
- **Bindery authentication** (user database)
- **Full transactional support** (TTS via branches + PR merges)

## Files (2,361 lines total)

- `ncp-server.js` (451 lines) - NCP protocol server
- `ncp-packet.js` (307 lines) - Packet parsing/building
- `ncp-client.js` (388 lines) - NCP client
- `nw-bindery.js` (540 lines) - User authentication database
- `nw-file-service.js` (295 lines) - File operations
- `nw-github-volume.js` (380 lines) - GitHub backend adapter

## The Genius Mapping

| NetWare Operation | GitHub API |
|-------------------|------------|
| Write file | Create commit |
| TTS Begin | Create branch |
| TTS End | Merge PR (atomic!) |
| TTS Abort | Delete branch |
| Read file | Get blob |
| List directory | Get tree |

**Every file operation is a Git commit. Every transaction is a branch + PR merge.**

## Usage

```javascript
const NCPServer = require('./ncp-server');

const server = new NCPServer({
  port: 524,
  github: {
    token: 'ghp_...',
    owner: 'bclark00',
    repo: 'netware-volume'
  }
});

server.start();
```

## NetWare Client

Any NetWare 3.12 client can connect:
- DOS client with NETX/VLM
- Windows client with Client32
- Modern NCP client

## Implementation Notes

Ported from TurboPower BTF NWBase.PAS / NWConn.PAS

Functions implemented:
- 0x61: Create Service Connection
- 0x17: Bindery (all sub-functions)
- 0x20: Semaphores
- 0x22: TTS (Transactional Tracking System)
- 0x21: Broadcast messages
- 0x63: Logout

## Why This Exists

Because we can. And because GitHub makes an excellent transactional filesystem.

---

💀🔥🚀 **"Run NetWare 3.12 on GitHub. Because why not."**

---

## STCS & the Genesis Ecosystem

This repository is the canonical open reference implementation of the
**STCS (Structured Transport and Communication Specification)** — a modern
recast of the NetWare Core Protocol for GitHub-backed, cloud-native infrastructure.

| Layer | What it is | License |
|---|---|---|
| This repo | STCS reference implementation | Apache 2.0 (open) |
| STCS RFC/Spec | Protocol specification | Genesis Systems Proprietary |
| Genesis Core | Production stack + integrations | Commercial / Partner |
| Certified builds | Validated Genesis-compatible products | Commercial license |

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2025 Genesis Systems (a dba of Exponential Systems)

Ported from TurboPower Pascal sources (NWBase.PAS / NWConn.PAS, circa 199x).
The Node.js implementation and GitHub-backed architecture are original work.

**Commercial Genesis ecosystem integrations, certified implementations, and
enterprise support are available via Genesis Systems.**
See [COMMERCIAL.md](COMMERCIAL.md) for details.
