#!/usr/bin/env node
/**
 * Genesis Orchestrator v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Composable distributed orchestration.
 * Lineage: Time Machine → Planner-Choreographer → v1 → v2 (distributed)
 *
 * Architecture:
 *
 *   PLANNER  — decomposes a goal into a chunk DAG
 *   EXECUTOR — fan-out per chunk: CODE + INTEGRATION + AUDIT → MERGE
 *   DISPATCH — each chunk runs locally OR on a remote peer orchestrator
 *   LISTENER — HTTP server mode; peer orchestrators POST chunks here
 *
 * Modes:
 *   node genesis-orchestrator.mjs --plan ncp           # coordinator
 *   node genesis-orchestrator.mjs --listen 7700        # worker (any port)
 *   node genesis-orchestrator.mjs --goal "..."         # free-form
 *   node genesis-orchestrator.mjs --resume <planfile>  # resume
 *   node genesis-orchestrator.mjs --dry-run --plan ncp # no LLM calls
 *
 * Peer registry (vault key: GENESIS_PEERS):
 *   Comma-separated URLs of remote worker nodes.
 *   e.g. GENESIS_PEERS=http://localhost:7701,http://10.27.1.176:7700
 *   Workers are round-robin selected per chunk. Falls back to local on error.
 *
 * Vault keys:
 *   ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / XAI_API_KEY
 *   GITHUB_TOKEN_PRIME_VELOCITY  GitHub context fetch
 *   GENESIS_MODEL                model override
 *   GENESIS_OUT                  output dir override
 *   GENESIS_PEERS                comma-separated peer URLs (coordinator only)
 *   GENESIS_LISTEN_PORT          default listen port (worker mode)
 */

'use strict';

import { writeFileSync, readFileSync, mkdirSync }  from 'fs';
import { join }                                    from 'path';
import { createServer }                            from 'http';
import { muxCall, vaultGet }                       from './provider-mux.mjs';

// ── Config ────────────────────────────────────────────────────────────────────

const GH_TOKEN  = vaultGet('GITHUB_TOKEN_PRIME_VELOCITY') ?? vaultGet('GITHUB_TOKEN_BCLARK00');
const MODEL     = vaultGet('GENESIS_MODEL') ?? 'claude-sonnet-4-20250514';
const OUT_DIR   = vaultGet('GENESIS_OUT')   ?? './genesis-out';

// Peer URLs — remote worker orchestrators to dispatch chunks to
const PEERS = (vaultGet('GENESIS_PEERS') ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DRY_RUN      = process.argv.includes('--dry-run');
const GOAL_IDX     = process.argv.indexOf('--goal');
const GOAL         = GOAL_IDX     !== -1 ? process.argv[GOAL_IDX + 1]     : null;
const PLAN_IDX     = process.argv.indexOf('--plan');
const PLAN_PRESET  = PLAN_IDX     !== -1 ? process.argv[PLAN_IDX + 1]     : null;
const RESUME_IDX   = process.argv.indexOf('--resume');
const RESUME_FILE  = RESUME_IDX   !== -1 ? process.argv[RESUME_IDX + 1]   : null;
const CHUNK_IDX    = process.argv.indexOf('--chunk');
const CHUNK_FILTER = CHUNK_IDX    !== -1 ? parseInt(process.argv[CHUNK_IDX + 1]) : null;
const LISTEN_IDX   = process.argv.indexOf('--listen');
const LISTEN_PORT  = LISTEN_IDX   !== -1 ? parseInt(process.argv[LISTEN_IDX + 1])
                                          : (vaultGet('GENESIS_LISTEN_PORT') ? parseInt(vaultGet('GENESIS_LISTEN_PORT')) : null);
const CONTEXT_HINT = (() => { const i = process.argv.indexOf('--context'); return i !== -1 ? process.argv[i+1] : null; })();

// ── LLM call ─────────────────────────────────────────────────────────────────

async function claudeCall({ system, prompt, label, maxTokens = 8000 }) {
  if (DRY_RUN) { console.log(`  [dry-run] ${label}`); return `(dry-run placeholder for ${label})`; }
  return muxCall({ system, prompt, maxTokens });
}

// ── GitHub context fetcher ────────────────────────────────────────────────────

async function fetchGitHubFiles(owner, repo, paths, token) {
  if (!token) return '(no GH token — context unavailable)';
  console.log(`[ctx] Fetching ${paths.length} files from ${owner}/${repo}...`);
  const results = await Promise.all(paths.map(async p => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}`,
        { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.raw', 'User-Agent': 'genesis-orchestrator/2.0' } }
      );
      if (!res.ok) { console.warn(`  [ctx] ${p}: ${res.status}`); return `// ${p} (unavailable)\n`; }
      const text = await res.text();
      console.log(`  [ctx] ${p} (${text.length} chars)`);
      return `\n// ===== ${p} =====\n${text}`;
    } catch (e) { return `// ${p} (error: ${e.message})\n`; }
  }));
  return results.join('');
}

// ── DAG resolver ──────────────────────────────────────────────────────────────

function buildExecutionWaves(chunks) {
  const done = new Set(), waves = [];
  let remaining = [...chunks];
  while (remaining.length > 0) {
    const wave = remaining.filter(c => (c.dependsOn ?? []).every(d => done.has(d)));
    if (!wave.length) throw new Error(`DAG cycle among: ${remaining.map(c=>c.name).join(', ')}`);
    waves.push(wave);
    wave.forEach(c => done.add(c.name));
    remaining = remaining.filter(c => !done.has(c.name));
  }
  return waves;
}

// ── Peer dispatcher ───────────────────────────────────────────────────────────
// Peers are treated as composable chunk executors. The coordinator's DAG logic
// is unchanged — it just hands chunk work units to whichever node is available.

let _peerIdx = 0;

function nextPeer() {
  if (!PEERS.length) return null;
  const peer = PEERS[_peerIdx % PEERS.length];
  _peerIdx++;
  return peer;
}

async function dispatchToPeer(peer, { chunk, plan, codebaseContext }) {
  console.log(`  [dispatch] -> ${peer} chunk:${chunk.name}`);
  const res = await fetch(`${peer}/execute`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ chunk, plan, codebaseContext }),
    signal:  AbortSignal.timeout(300_000),  // 5 min timeout per chunk
  });
  if (!res.ok) throw new Error(`Peer ${peer} returned ${res.status}: ${(await res.text()).slice(0,200)}`);
  return res.json();  // { chunk, agentResults, mergedCode }
}

// ── Chunk executor (local) ────────────────────────────────────────────────────

async function executeChunkLocally(chunk, plan, codebaseContext) {
  const roles     = chunk.roleSet ?? ['CODE', 'INTEGRATION', 'AUDIT'];
  const roleDescs = plan.roles ?? {};

  const sharedSystem = `You are a senior software engineer working on: ${plan.planTitle}.
System: ${plan.systemContext}
Conventions: production-ready, no placeholders, minimal commentary, complete implementations.`;

  const contextBlock = `
## SYSTEM CONTEXT
${plan.systemContext}

## CODEBASE
${codebaseContext}

## THIS CHUNK: ${chunk.title}
${chunk.description}
`;

  const agentPrompts = {
    CODE: `${contextBlock}
[CODE MODE -- ${roleDescs.CODE ?? 'Implement the module completely'}]
Produce the complete implementation for: ${chunk.outputFiles.join(', ')}
No TODOs, no stubs, no placeholders. Return file content only. No markdown fences.`,

    INTEGRATION: `${contextBlock}
[INTEGRATION MODE -- ${roleDescs.INTEGRATION ?? 'Analyze integration points'}]
Identify all touchpoints between this chunk and the existing codebase:
1. Exact import/require changes needed in existing files
2. Interface contracts this chunk must honour
3. Naming conflicts or collision risks
4. Shared state concerns
Format: ## TOUCHPOINTS / ## REQUIRED CHANGES (file-by-file) / ## CONCERNS`,

    AUDIT: `${contextBlock}
[AUDIT MODE -- ${roleDescs.AUDIT ?? 'Review for correctness and completeness'}]
Critically audit the chunk spec:
1. Spec ambiguities or gaps
2. Edge cases not covered
3. Error codes / failure modes
4. Security concerns
5. Top 5 test cases
Format: ## SPEC GAPS / ## EDGE CASES / ## ERROR MODES / ## SECURITY / ## TOP 5 TESTS`,

    RESEARCH: `${contextBlock}
[RESEARCH MODE]
1. Relevant standards, RFCs, or prior art
2. Design options with trade-offs
3. Recommended approach with rationale`,

    DESIGN: `${contextBlock}
[DESIGN MODE]
1. Data structures and type definitions
2. Public API surface (function signatures)
3. Internal algorithm outline
4. Integration diagram`,

    TEST: `${contextBlock}
[TEST MODE]
Write comprehensive tests for: ${chunk.outputFiles.join(', ')}
Return test file content only. No markdown fences.`,
  };

  const t0 = Date.now();
  const agentResults = await Promise.all(
    roles.map(role => {
      const prompt = agentPrompts[role];
      if (!prompt) throw new Error(`Unknown role: ${role}`);
      return claudeCall({ system: sharedSystem, prompt, label: `${chunk.name}:${role}` })
        .then(text => ({ role, text, ok: true }))
        .catch(err  => ({ role, text: `ERROR: ${err.message}`, ok: false }));
    })
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const failed  = agentResults.filter(r => !r.ok);
  console.log(`  Agents done ${elapsed}s${failed.length ? ` (${failed.length} failed)` : ''}`);
  console.log(`  Running MERGE...`);

  const agentSections = agentResults.map(r => `## ${r.role} AGENT\n${r.text}`).join('\n\n');
  const mergedCode = await claudeCall({
    system: sharedSystem, label: `${chunk.name}:MERGE`, maxTokens: 12000,
    prompt: `${roleDescs.MERGE ?? 'Synthesize agent outputs into final deliverables'}.

${agentSections}

## YOUR TASK
Synthesize into final deliverables. Fix issues raised by INTEGRATION and AUDIT agents.

Delimit each output file EXACTLY as:
===FILE: <filename>===
(content)

Required files: ${chunk.outputFiles.join(', ')}, ${chunk.testFile}
Also emit: ===FILE: integration-patch-${chunk.name}.md=== with exact changes needed in existing files.
No markdown fences inside file content blocks.`,
  });

  return { chunk, agentResults, mergedCode };
}

// ── buildChunk: dispatch or local ────────────────────────────────────────────

async function buildChunk(chunk, plan, codebaseContext) {
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`CHUNK ${chunk.id}: ${chunk.title}`);
  console.log(`  Roles: ${(chunk.roleSet ?? ['CODE','INTEGRATION','AUDIT']).join(' + ')}`);

  const peer = nextPeer();
  if (peer) {
    try {
      const result = await dispatchToPeer(peer, { chunk, plan, codebaseContext });
      console.log(`  [dispatch] ${chunk.name} done via ${peer}`);
      return result;
    } catch (err) {
      console.warn(`  [dispatch] ${peer} failed (${err.message}), falling back to local`);
    }
  }

  return executeChunkLocally(chunk, plan, codebaseContext);
}

// ── File parser ───────────────────────────────────────────────────────────────

function parseFiles(mergedCode, chunk) {
  const files = {}, parts = [], marker = /===FILE: ([^\n=]+)===/g;
  let m;
  while ((m = marker.exec(mergedCode)) !== null) parts.push({ filename: m[1].trim(), start: marker.lastIndex });
  for (let i = 0; i < parts.length; i++) {
    const end = i + 1 < parts.length ? mergedCode.indexOf(`===FILE: ${parts[i+1].filename}===`) : mergedCode.length;
    files[parts[i].filename] = mergedCode.slice(parts[i].start, end).trim();
  }
  if (!Object.keys(files).length) files[chunk.outputFiles[0]] = mergedCode.trim();
  return files;
}

// ── Plan persistence ──────────────────────────────────────────────────────────

function savePlan(plan, state) {
  mkdirSync(join(OUT_DIR, 'plans'), { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(OUT_DIR, 'plans', `plan-${ts}.json`);
  writeFileSync(path, JSON.stringify({ plan, state, savedAt: new Date().toISOString() }, null, 2));
  return path;
}

function loadPlan(path) { return JSON.parse(readFileSync(path, 'utf-8')); }

// ── LISTENER (worker mode) ────────────────────────────────────────────────────
// Accepts POST /execute from a coordinator. Runs the chunk locally using this
// node's own provider mux (separate rate limit pool). Returns JSON result.

function startListener(port) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, peers: PEERS.length, model: MODEL }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execute') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { chunk, plan, codebaseContext } = JSON.parse(body);
          console.log(`[worker] received chunk:${chunk.name} from coordinator`);
          const result = await executeChunkLocally(chunk, plan, codebaseContext);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[worker] chunk failed: ${err.message}`);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  server.listen(port, () => {
    console.log(`\n[WORKER] Genesis Orchestrator listening on :${port}`);
    console.log(`[WORKER] POST /execute  — accept chunk from coordinator`);
    console.log(`[WORKER] GET  /health   — liveness check`);
    console.log(`[WORKER] Provider chain: ${PEERS.length ? 'coordinator dispatches here' : 'local mux'}`);
  });

  return server;
}

// ── PLANNER AGENT ─────────────────────────────────────────────────────────────

async function planGoal(goal, contextHint) {
  console.log('\n[PLANNER] Decomposing goal...');
  console.log(`  Goal: ${goal}`);

  const system = `You are an expert software architect and project planner.
Your job is to decompose a software development goal into independent implementation chunks.
Each chunk will be built by a parallel team of specialized AI agents (CODE, INTEGRATION, AUDIT).
Output ONLY valid JSON — no prose, no markdown fences.`;

  const prompt = `Goal: ${goal}

${contextHint ? `Additional context: ${contextHint}\n` : ''}
Decompose this goal into 2-8 implementation chunks.

Rules:
- Each chunk must be independently buildable
- Specify explicit dependencies in "dependsOn"
- Chunks with no dependencies run in parallel first
- roleSet options: CODE, INTEGRATION, AUDIT, RESEARCH, DESIGN, TEST

Return JSON:
{
  "planTitle": "...",
  "planDescription": "...",
  "systemContext": "...",
  "roles": { "CODE":"...", "INTEGRATION":"...", "AUDIT":"...", "MERGE":"..." },
  "chunks": [{
    "id": 0, "name": "slug", "title": "...", "dependsOn": [],
    "roleSet": ["CODE","INTEGRATION","AUDIT"],
    "outputFiles": ["file.js"], "testFile": "test-file.js",
    "description": "..."
  }]
}`;

  const raw = await claudeCall({ system, prompt, label: 'PLANNER', maxTokens: 4000 });
  if (DRY_RUN) return { planTitle:'Dry-run', planDescription:goal, systemContext:'dry-run',
    roles:{CODE:'impl',INTEGRATION:'integrate',AUDIT:'audit',MERGE:'synthesize'},
    chunks:[{id:0,name:'dry-run',title:'Dry run',dependsOn:[],roleSet:['CODE','INTEGRATION','AUDIT'],outputFiles:['dry-run.js'],testFile:'test-dry-run.js',description:goal}] };

  try {
    const cleaned = raw.replace(/^```json\s*/m,'').replace(/^```\s*/m,'').replace(/```\s*$/m,'').trim();
    const plan = JSON.parse(cleaned);
    console.log(`  [PLANNER] -> ${plan.chunks.length} chunks: ${plan.chunks.map(c=>c.name).join(', ')}`);
    return plan;
  } catch (e) {
    throw new Error(`PLANNER output not valid JSON: ${e.message}\nRaw:\n${raw.slice(0,500)}`);
  }
}

// ── Built-in presets ──────────────────────────────────────────────────────────

const PRESETS = {
  ncp: {
    planTitle:       'NetWare NCP Server -- Remaining Function Groups',
    planDescription: 'Implement 5 remaining NCP subsystems',
    systemContext:   'Node.js NetWare Core Protocol. CommonJS. Files: ncp-packet.js, ncp-server.js, ncp-client.js, nw-bindery.js, nw-file-service.js, index.js.',
    roles: {
      CODE:        'Implement the nw-*.js service class with all methods and a registerHandlers(server, services) export',
      INTEGRATION: 'Identify exact changes to ncp-server.js dispatcher and index.js wiring for this service',
      AUDIT:       'Review NCP spec compliance, error completion codes, edge cases, and required test cases',
      MERGE:       'Synthesize into final nw-*.js, integration patch, and test file',
    },
    chunks: [
      { id:0, name:'login-auth',      title:'Login / Authentication',      dependsOn:[], roleSet:['CODE','INTEGRATION','AUDIT'], outputFiles:['nw-login-auth.js'],    testFile:'test-ncp-login-auth.js',
        description:`NCPLoginService. NCP 0x0014-0x0024. login/logout, getLoginKey (8-byte challenge), keyedLogin (XOR), getConnectionInfo, getInternetAddress. Connection table Map<connId,{stationId,loginName,loginTime,objectId}>. 1-based stations, max 250.` },
      { id:1, name:'queue-subsystem', title:'Queue Management',             dependsOn:[], roleSet:['CODE','INTEGRATION','AUDIT'], outputFiles:['nw-queue.js'],         testFile:'test-ncp-queue.js',
        description:`NCPQueueService. NCP 0x0064-0x0077. createQueue, destroyQueue, getQueueStatus, createJob, startJob, removeJob, listJobs, getJob, changeJobPosition, attachServer, detachServer, serviceNextJob, finishJob, abortJob. Job lifecycle: WAITING->ACTIVE->DONE|ABORTED.` },
      { id:2, name:'accounting',      title:'Accounting',                   dependsOn:[], roleSet:['CODE','INTEGRATION','AUDIT'], outputFiles:['nw-accounting.js'],    testFile:'test-ncp-accounting.js',
        description:`NCPAccountingService. NCP 0x0096-0x0099. getStatus, charge, hold/releaseHold, note, setLimit, listNotes. Balance/hold/limit per objectId. Credit limit enforcement.` },
      { id:3, name:'console-mgmt',    title:'Console / Server Management', dependsOn:[], roleSet:['CODE','INTEGRATION','AUDIT'], outputFiles:['nw-console.js'],       testFile:'test-ncp-console.js',
        description:`NCPConsoleService. NCP 0x00C8-0x00E9. disableLogin, enableLogin, getLoginStatus, getServerInfo, getTTSStats, getCacheStats, getLANInfo, getBroadcastBuffer, clearBroadcastBuffer, downServer. downServer emits 'shutdown' after delay.` },
      { id:4, name:'tcp-transport',   title:'TCP Transport',                dependsOn:[], roleSet:['CODE','INTEGRATION','AUDIT'], outputFiles:['nw-tcp-transport.js'], testFile:'test-ncp-tcp.js',
        description:`NCPTCPTransport extends EventEmitter. net.Server. 4-byte BE length framing. Per-socket state: connId, readBuf, expecting. listen(), close(), send(connId,buf). Events: 'packet','connect','disconnect'. NCPServer accepts transport:'tcp'|'udp'|'both'.` },
    ],
  },
};

const PRESET_CONTEXT = {
  ncp: { owner:'Prime-Velocity', repo:'netware-ncp-server', files:['ncp-packet.js','ncp-server.js','ncp-client.js','nw-bindery.js','nw-file-service.js','index.js'] },
};

async function buildContext(planTitle) {
  for (const [key, cfg] of Object.entries(PRESET_CONTEXT)) {
    if (planTitle.toLowerCase().includes(key) || PLAN_PRESET === key)
      return fetchGitHubFiles(cfg.owner, cfg.repo, cfg.files, GH_TOKEN);
  }
  return CONTEXT_HINT ? `Context hint: ${CONTEXT_HINT}` : '(no codebase context)';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Worker mode — start listener and wait forever
  if (LISTEN_PORT) {
    startListener(LISTEN_PORT);
    return;  // server keeps process alive
  }

  console.log('\n+----------------------------------------------------------+');
  console.log('|  GENESIS ORCHESTRATOR v2.0 (composable)                  |');
  console.log('|  Planner -> DAG -> dispatch(peer|local) -> Merge         |');
  console.log('+----------------------------------------------------------+');
  console.log(`Model:    ${MODEL}`);
  console.log(`Out dir:  ${OUT_DIR}`);
  console.log(`Peers:    ${PEERS.length ? PEERS.join(', ') : '(none — local only)'}`);
  console.log(`Dry run:  ${DRY_RUN}`);

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, 'raw'), { recursive: true });

  // Health-check peers before starting
  if (PEERS.length) {
    console.log('\n[PEERS] Checking connectivity...');
    for (const peer of PEERS) {
      try {
        const r = await fetch(`${peer}/health`, { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        console.log(`  ${peer} — ok (model: ${d.model})`);
      } catch (e) {
        console.warn(`  ${peer} — unreachable (${e.message}), will skip`);
        // Remove unreachable peer from rotation
        PEERS.splice(PEERS.indexOf(peer), 1);
        _peerIdx = 0;
      }
    }
    console.log(`[PEERS] ${PEERS.length} reachable peer(s)`);
  }

  // Resolve plan
  let plan;
  if (RESUME_FILE) {
    plan = loadPlan(RESUME_FILE).plan;
    console.log(`\n[RESUME] ${plan.planTitle} (${plan.chunks.length} chunks)`);
  } else if (PLAN_PRESET) {
    if (!PRESETS[PLAN_PRESET]) { console.error(`Unknown preset: ${PLAN_PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`); process.exit(1); }
    plan = PRESETS[PLAN_PRESET];
    console.log(`\n[PRESET] ${plan.planTitle}`);
  } else if (GOAL) {
    plan = await planGoal(GOAL, CONTEXT_HINT);
  } else {
    console.error('\nERROR: Provide --goal "..." or --plan <preset> or --resume <file> or --listen <port>');
    console.error(`Presets: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  const planPath = savePlan(plan, { status:'running', startedAt: new Date().toISOString() });
  console.log(`[PLAN] ${plan.chunks.length} chunks: ${plan.chunks.map(c=>c.name).join(', ')}`);
  console.log(`[PLAN] Saved: ${planPath}`);

  const codebaseContext = await buildContext(plan.planTitle ?? '');

  let chunks = plan.chunks;
  if (CHUNK_FILTER !== null) {
    chunks = chunks.filter(c => c.id === CHUNK_FILTER);
    if (!chunks.length) { console.error(`No chunk id=${CHUNK_FILTER}`); process.exit(1); }
  }

  const waves = buildExecutionWaves(chunks);
  console.log(`\n[DAG] ${waves.length} wave(s): ${waves.map((w,i)=>`W${i+1}:[${w.map(c=>c.name).join(',')}]`).join(' -> ')}`);

  const allResults = [];
  const t0global   = Date.now();

  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`WAVE ${wi+1}/${waves.length} -- ${wave.length} chunk(s) in parallel`);
    const t0wave = Date.now();
    const waveResults = await Promise.allSettled(wave.map(c => buildChunk(c, plan, codebaseContext)));
    console.log(`\nWave ${wi+1} done in ${((Date.now()-t0wave)/1000).toFixed(1)}s`);
    allResults.push(...waveResults);
  }

  const totalElapsed = ((Date.now()-t0global)/1000).toFixed(1);

  console.log('\n[WRITE] Writing outputs...');
  const summary = [];

  for (const result of allResults) {
    if (result.status === 'rejected') {
      console.error(`  CHUNK FAILED: ${result.reason}`);
      summary.push({ status:'failed', error: String(result.reason) });
      continue;
    }
    const { chunk, agentResults, mergedCode } = result.value;
    for (const ar of agentResults)
      writeFileSync(join(OUT_DIR, 'raw', `${chunk.name}-${ar.role.toLowerCase()}.txt`), ar.text, 'utf-8');
    writeFileSync(join(OUT_DIR, 'raw', `${chunk.name}-merged.txt`), mergedCode, 'utf-8');

    const files = parseFiles(mergedCode, chunk);
    const written = [];
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(OUT_DIR, filename), content, 'utf-8');
      written.push(filename);
      console.log(`  ${join(OUT_DIR, filename)} (${content.length} chars)`);
    }
    summary.push({ chunk: chunk.name, status:'ok', files: written });
  }

  savePlan(plan, { status:'complete', elapsed:`${totalElapsed}s`, chunks: summary });
  writeFileSync(join(OUT_DIR, 'build-summary.json'), JSON.stringify({
    planTitle: plan.planTitle, ts: new Date().toISOString(),
    elapsed: `${totalElapsed}s`, model: MODEL, peers: PEERS, waves: waves.length, chunks: summary,
  }, null, 2), 'utf-8');

  console.log(`\n[DONE] ${totalElapsed}s total`);
  console.log(`Summary: ${join(OUT_DIR, 'build-summary.json')}`);
  console.log(`Resume:  --resume ${planPath}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
