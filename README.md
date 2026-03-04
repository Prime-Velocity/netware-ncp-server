# netware-ncp-server

**The open reference implementation of the STCS (Structured Transport and Communication Specification).**

A complete NetWare 3.12-compatible NCP server in Node.js, using GitHub as the backing store.
2,361 lines. Production-grade protocol implementation. Apache 2.0.

> _This started as a joke this morning. It is no longer a joke._

---

## What This Is

NetWare Core Protocol (NCP) — the session and transport layer that powered enterprise
networks through the 1990s — reimplemented in Node.js with GitHub as the filesystem backend.

Every file write is a commit. Every transaction is a branch and PR merge. Every directory
listing is a tree fetch. The Bindery (NetWare's identity system) maps cleanly to GitHub's
user and permission model.

What began as an experiment in unlikely mappings turned into something more significant:
a viable protocol foundation for distributed, Git-native infrastructure. That realization
is what STCS formalizes.

## Architecture

- **NCP Server** (`ncp-server.js`, 451 lines) — UDP port 524, full connection state machine
- **Packet layer** (`ncp-packet.js`, 307 lines) — NCP framing, parsing, and building
- **NCP Client** (`ncp-client.js`, 388 lines) — compatible client implementation
- **Bindery** (`nw-bindery.js`, 540 lines) — identity and authentication, GitHub-backed
- **File service** (`nw-file-service.js`, 295 lines) — file operations
- **GitHub volume** (`nw-github-volume.js`, 380 lines) — GitHub API adapter

## The Mapping

| NetWare Operation | GitHub API            |
|-------------------|-----------------------|
| Write file        | Create commit         |
| TTS Begin         | Create branch         |
| TTS End           | Merge PR (atomic)     |
| TTS Abort         | Delete branch         |
| Read file         | Get blob              |
| List directory    | Get tree              |

**Every file operation is a Git commit. Every transaction is a branch + PR merge.**
This is not a trick — it is architecturally correct.

## Usage

```javascript
const NCPServer = require('./ncp-server');

const server = new NCPServer({
  port: 524,
  github: {
    token: 'ghp_...',
    owner: 'your-org',
    repo: 'netware-volume'
  }
});

server.start();
```

Any NetWare 3.12 client connects normally: DOS (NETX/VLM), Windows (Client32), or modern NCP clients.

## Protocol Coverage

NCP functions implemented:

- `0x61` Create Service Connection
- `0x17` Bindery (all sub-functions)
- `0x20` Semaphores
- `0x21` Broadcast messages
- `0x22` TTS (Transactional Tracking System)
- `0x63` Logout

## Provenance

Ported from TurboPower Pascal sources (NWBase.PAS / NWConn.PAS, circa 199x).
The Node.js implementation, GitHub-backed architecture, and STCS formalization
are original work by Genesis Systems.

## STCS & the Genesis Ecosystem

This repository is the canonical open reference implementation of **STCS** —
the protocol specification that formalizes this architecture for production use.

| Layer | What it is | License |
|---|---|---|
| This repo | STCS reference implementation | Apache 2.0 (open) |
| STCS RFC/Spec | Protocol specification | Genesis Systems Proprietary |
| Genesis Core | Production stack + integrations | Commercial / Partner |
| Certified builds | Validated Genesis-compatible products | Commercial license |

The open reference exists to prove the protocol works and give the community a
foundation. Genesis Core is where production hardening, SLAs, and full ecosystem
integration live. See [COMMERCIAL.md](COMMERCIAL.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2025 Genesis Systems (a dba of Exponential Systems)

**Commercial Genesis ecosystem integrations, certified implementations, and
enterprise support are available via Genesis Systems.**
See [COMMERCIAL.md](COMMERCIAL.md) for details.
