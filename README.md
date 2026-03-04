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
