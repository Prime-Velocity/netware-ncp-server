#!/usr/bin/env node
/**
 * Genesis Orchestrator v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Formal replacement for October Planner-Choreographer.
 * Lineage: Time Machine → Planner-Choreographer → genesis-orchestrator
 *
 * Architecture (3 layers):
 *
 *   PLANNER  — LLM decomposes a free-form goal into a typed chunk manifest
 *              with dependency edges (DAG). Replaces hardcoded task lists.
 *
 *   EXECUTOR — ai2-parallel-fanout (proven pattern) per chunk:
 *              CODE + INTEGRATION + AUDIT run in parallel → MERGE synthesizes.
 *              Roles are configurable per plan type.
 *
 *   STORE    — JSON plan files on disk (intent-graph integration point).
 *              Each run is a durable plan that can be resumed.
 *
 * Usage:
 *   # Free-form goal → planner decomposes → executor builds
 *   ANTHROPIC_API_KEY=sk-ant-... node genesis-orchestrator.mjs \
 *     --goal "Add login/auth and queue subsystem to netware-ncp-server"
 *
 *   # Built-in preset (skips planner)
 *   node genesis-orchestrator.mjs --plan ncp
 *   node genesis-orchestrator.mjs --plan ncp --chunk 0
 *
 *   # Resume a previous plan
 *   node genesis-orchestrator.mjs --resume ./plans/plan-2026-03-06T123456.json
 *
 *   # Dry-run (no API calls)
 *   node genesis-orchestrator.mjs --goal "..." --dry-run
 *
 * Env:
 *   ANTHROPIC_API_KEY   primary provider (+ GEMINI_API_KEY, OPENAI_API_KEY, XAI_API_KEY for mux fallback)
 *   GITHUB_TOKEN_PRIME_VELOCITY  GitHub context fetch (from vault)
 *   GENESIS_MODEL       optional model override (vault key)
 *   GENESIS_OUT         override output dir (default: ./genesis-out)
 */

'use strict';

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join }                                               from 'path';
import { muxCall, vaultGet }                                   from './provider-mux.mjs';

// ── Config ────────────────────────────────────────────────────────────────────


const GH_TOKEN = vaultGet('GITHUB_TOKEN_PRIME_VELOCITY') ?? vaultGet('GITHUB_TOKEN_BCLARK00');
const MODEL    = vaultGet('GENESIS_MODEL') ?? 'claude-sonnet-4-20250514';
const OUT_DIR  = vaultGet('GENESIS_OUT')   ?? './genesis-out';


const DRY_RUN      = process.argv.includes('--dry-run');
const GOAL_IDX     = process.argv.indexOf('--goal');
const GOAL         = GOAL_IDX !== -1 ? process.argv[GOAL_IDX + 1] : null;
const PLAN_IDX     = process.argv.indexOf('--plan');
const PLAN_PRESET  = PLAN_IDX !== -1 ? process.argv[PLAN_IDX + 1] : null;
const RESUME_IDX   = process.argv.indexOf('--resume');
const RESUME_FILE  = RESUME_IDX !== -1 ? process.argv[RESUME_IDX + 1] : null;
const CHUNK_IDX    = process.argv.indexOf('--chunk');
const CHUNK_FILTER = CHUNK_IDX !== -1 ? parseInt(process.argv[CHUNK_IDX + 1]) : null;
const CONTEXT_HINT = (() => {
  const i = process.argv.indexOf('--context');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// ── LLM call — routes through provider-mux ────────────────────────────────────

async function claudeCall({ system, prompt, label, maxTokens = 8000 }) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${label}`);
    return `(dry-run placeholder for ${label})`;
  }
  return muxCall({ system, prompt, maxTokens });
}

// ── GitHub context fetcher ────────────────────────────────────────────────────

async function fetchGitHubFiles(owner, repo, paths, token) {
  if (!token) return '(no GH_TOKEN — context unavailable)';
  console.log(`[ctx] Fetching ${paths.length} files from ${owner}/${repo}...`);
  const results = await Promise.all(paths.map(async p => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}`,
        { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.raw', 'User-Agent': 'genesis-orchestrator/1.0' } }
      );
      if (!res.ok) { console.warn(`  [ctx] ${p}: ${res.status}`); return `// ${p} (unavailable)\n`; }
      const text = await res.text();
      console.log(`  [ctx] ${p} (${text.length} chars)`);
      return `\n// ===== ${p} =====\n${text}`;
    } catch (e) {
      return `// ${p} (error: ${e.message})\n`;
    }
  }));
  return results.join('');
}

// ── DAG resolver ──────────────────────────────────────────────────────────────

function buildExecutionWaves(chunks) {
  const done   = new Set();
  const waves  = [];
  let remaining = [...chunks];
  while (remaining.length > 0) {
    const wave = remaining.filter(c =>
      (c.dependsOn ?? []).every(dep => done.has(dep))
    );
    if (wave.length === 0) {
      const names = remaining.map(c => c.name).join(', ');
      throw new Error(`DAG cycle or unsatisfied dependency among: ${names}`);
    }
    waves.push(wave);
    wave.forEach(c => done.add(c.name));
    remaining = remaining.filter(c => !done.has(c.name));
  }
  return waves;
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
- Each chunk must be independently buildable (no implicit coupling)
- Specify explicit dependencies using chunk names in "dependsOn"
- Chunks with no dependencies run in parallel first
- Each chunk produces one or more named output files
- roleSet: which agent roles to use (default: ["CODE","INTEGRATION","AUDIT"])
  Use ["RESEARCH","DESIGN","AUDIT"] for architecture/planning chunks
  Use ["CODE","TEST","AUDIT"] for pure implementation chunks

Return a JSON object with this exact shape:
{
  "planTitle": "Short descriptive title",
  "planDescription": "What this plan builds",
  "systemContext": "Brief description of the system being modified (for agent context)",
  "roles": {
    "CODE":        "What the CODE agent does for this plan type",
    "INTEGRATION": "What the INTEGRATION agent does",
    "AUDIT":       "What the AUDIT agent does",
    "MERGE":       "What the MERGE agent synthesizes"
  },
  "chunks": [
    {
      "id": 0,
      "name": "slug-name",
      "title": "Human readable title",
      "dependsOn": [],
      "roleSet": ["CODE", "INTEGRATION", "AUDIT"],
      "outputFiles": ["filename.js"],
      "testFile": "test-filename.js",
      "description": "Detailed spec of exactly what to implement in this chunk."
    }
  ]
}`;

  const raw = await claudeCall({ system, prompt, label: 'PLANNER', maxTokens: 4000 });

  if (DRY_RUN) {
    return {
      planTitle: 'Dry-run plan', planDescription: goal, systemContext: 'dry-run',
      roles: { CODE: 'implement', INTEGRATION: 'integrate', AUDIT: 'audit', MERGE: 'synthesize' },
      chunks: [{ id: 0, name: 'dry-run-chunk', title: 'Dry run chunk', dependsOn: [], roleSet: ['CODE','INTEGRATION','AUDIT'], outputFiles: ['dry-run.js'], testFile: 'test-dry-run.js', description: goal }],
    };
  }

  try {
    const cleaned = raw.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();
    const plan = JSON.parse(cleaned);
    console.log(`  [PLANNER] -> ${plan.chunks.length} chunks: ${plan.chunks.map(c => c.name).join(', ')}`);
    return plan;
  } catch (e) {
    throw new Error(`PLANNER output was not valid JSON: ${e.message}\nRaw:\n${raw.slice(0, 500)}`);
  }
}

// ── EXECUTOR: fan-out per chunk ───────────────────────────────────────────────

async function buildChunk(chunk, plan, codebaseContext) {
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

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`CHUNK ${chunk.id}: ${chunk.title}`);
  console.log(`  Roles: ${roles.join(' + ')}`);

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

// ── File parser ───────────────────────────────────────────────────────────────

function parseFiles(mergedCode, chunk) {
  const files  = {};
  const marker = /===FILE: ([^\n=]+)===/g;
  const parts  = [];
  let m;
  while ((m = marker.exec(mergedCode)) !== null) {
    parts.push({ filename: m[1].trim(), start: marker.lastIndex });
  }
  for (let i = 0; i < parts.length; i++) {
    const nextMarker = i + 1 < parts.length
      ? mergedCode.indexOf(`===FILE: ${parts[i + 1].filename}===`)
      : mergedCode.length;
    files[parts[i].filename] = mergedCode.slice(parts[i].start, nextMarker).trim();
  }
  if (Object.keys(files).length === 0) {
    files[chunk.outputFiles[0]] = mergedCode.trim();
  }
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

function loadPlan(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── Built-in presets ──────────────────────────────────────────────────────────

const PRESETS = {
  ncp: {
    planTitle:       'NetWare NCP Server -- Remaining Function Groups',
    planDescription: 'Implement 5 remaining NCP subsystems: login/auth, queues, accounting, console mgmt, TCP transport',
    systemContext:   'Node.js implementation of NetWare Core Protocol. CommonJS. Files: ncp-packet.js (constants), ncp-server.js (dispatcher), ncp-client.js, nw-bindery.js, nw-file-service.js, nw-github-volume.js, index.js.',
    roles: {
      CODE:        'Implement the nw-*.js service class with all methods and a registerHandlers(server, services) export',
      INTEGRATION: 'Identify exact changes to ncp-server.js dispatcher and index.js wiring for this service',
      AUDIT:       'Review NCP spec compliance, error completion codes, edge cases, and required test cases',
      MERGE:       'Synthesize into final nw-*.js, integration patch, and test file',
    },
    chunks: [
      {
        id: 0, name: 'login-auth', title: 'Login / Authentication',
        dependsOn: [], roleSet: ['CODE','INTEGRATION','AUDIT'],
        outputFiles: ['nw-login-auth.js'], testFile: 'test-ncp-login-auth.js',
        description: `NCPLoginService class. NCP functions 0x0014-0x0024.
login/logout, getLoginKey (8-byte challenge), keyedLogin (XOR response),
getConnectionInfo, getInternetAddress.
Connection table Map<connId,{stationId,loginName,loginTime,objectId}>.
Station numbering 1-based, max 250. registerHandlers(server,{loginSvc,bindery}).`,
      },
      {
        id: 1, name: 'queue-subsystem', title: 'Queue Management',
        dependsOn: [], roleSet: ['CODE','INTEGRATION','AUDIT'],
        outputFiles: ['nw-queue.js'], testFile: 'test-ncp-queue.js',
        description: `NCPQueueService. NCP functions 0x0064-0x0077.
createQueue, destroyQueue, getQueueStatus, createJob, startJob, removeJob,
listJobs, getJob, changeJobPosition, attachServer, detachServer,
serviceNextJob, finishJob, abortJob.
Job lifecycle: WAITING->ACTIVE->DONE|ABORTED.`,
      },
      {
        id: 2, name: 'accounting', title: 'Accounting',
        dependsOn: [], roleSet: ['CODE','INTEGRATION','AUDIT'],
        outputFiles: ['nw-accounting.js'], testFile: 'test-ncp-accounting.js',
        description: `NCPAccountingService. NCP functions 0x0096-0x0099.
getStatus, charge, hold/releaseHold, note, setLimit, listNotes.
Balance/hold/limit per objectId. Credit limit enforcement.`,
      },
      {
        id: 3, name: 'console-mgmt', title: 'Console / Server Management',
        dependsOn: [], roleSet: ['CODE','INTEGRATION','AUDIT'],
        outputFiles: ['nw-console.js'], testFile: 'test-ncp-console.js',
        description: `NCPConsoleService. NCP functions 0x00C8-0x00E9.
disableLogin, enableLogin, getLoginStatus, getServerInfo, getTTSStats,
getCacheStats, getLANInfo, getBroadcastBuffer, clearBroadcastBuffer, downServer.
downServer emits 'shutdown' event after delay.`,
      },
      {
        id: 4, name: 'tcp-transport', title: 'TCP Transport',
        dependsOn: [], roleSet: ['CODE','INTEGRATION','AUDIT'],
        outputFiles: ['nw-tcp-transport.js'], testFile: 'test-ncp-tcp.js',
        description: `NCPTCPTransport extends EventEmitter. net.Server.
4-byte big-endian length framing. Per-socket state: connId, readBuf, expecting.
listen(), close(), send(connId,buf).
Events: 'packet', 'connect', 'disconnect'.
NCPServer accepts transport:'tcp'|'udp'|'both'.`,
      },
    ],
  },
};

// ── Context fetcher ───────────────────────────────────────────────────────────

const PRESET_CONTEXT = {
  ncp: { owner: 'Prime-Velocity', repo: 'netware-ncp-server', files: ['ncp-packet.js','ncp-server.js','ncp-client.js','nw-bindery.js','nw-file-service.js','index.js'] },
};

async function buildContext(planTitle) {
  for (const [key, cfg] of Object.entries(PRESET_CONTEXT)) {
    if (planTitle.toLowerCase().includes(key) || PLAN_PRESET === key) {
      return fetchGitHubFiles(cfg.owner, cfg.repo, cfg.files, GH_TOKEN);
    }
  }
  return CONTEXT_HINT ? `Context hint: ${CONTEXT_HINT}` : '(no codebase context)';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n+----------------------------------------------------------+');
  console.log('|  GENESIS ORCHESTRATOR v1.0                               |');
  console.log('|  Planner -> ai2-parallel-fanout -> Merge                 |');
  console.log('+----------------------------------------------------------+');
  console.log(`Model:    ${MODEL}`);
  console.log(`Out dir:  ${OUT_DIR}`);
  console.log(`Dry run:  ${DRY_RUN}`);

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, 'raw'), { recursive: true });

  // Resolve plan
  let plan;
  if (RESUME_FILE) {
    const saved = loadPlan(RESUME_FILE);
    plan = saved.plan;
    console.log(`\n[RESUME] ${plan.planTitle} (${plan.chunks.length} chunks)`);
  } else if (PLAN_PRESET) {
    if (!PRESETS[PLAN_PRESET]) { console.error(`Unknown preset: ${PLAN_PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`); process.exit(1); }
    plan = PRESETS[PLAN_PRESET];
    console.log(`\n[PRESET] ${plan.planTitle}`);
  } else if (GOAL) {
    plan = await planGoal(GOAL, CONTEXT_HINT);
  } else {
    console.error('\nERROR: Provide --goal "..." or --plan <preset> or --resume <file>');
    console.error(`Presets: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  const planPath = savePlan(plan, { status: 'running', startedAt: new Date().toISOString() });
  console.log(`[PLAN] ${plan.chunks.length} chunks: ${plan.chunks.map(c => c.name).join(', ')}`);
  console.log(`[PLAN] Saved: ${planPath}`);

  const codebaseContext = await buildContext(plan.planTitle ?? '');

  // DAG
  let chunks = plan.chunks;
  if (CHUNK_FILTER !== null) {
    chunks = chunks.filter(c => c.id === CHUNK_FILTER);
    if (!chunks.length) { console.error(`No chunk id=${CHUNK_FILTER}`); process.exit(1); }
  }

  const waves = buildExecutionWaves(chunks);
  console.log(`\n[DAG] ${waves.length} wave(s): ${waves.map((w,i) => `W${i+1}:[${w.map(c=>c.name).join(',')}]`).join(' -> ')}`);

  // Execute
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

  // Write outputs
  console.log('\n[WRITE] Writing outputs...');
  const summary = [];

  for (const result of allResults) {
    if (result.status === 'rejected') {
      console.error(`  CHUNK FAILED: ${result.reason}`);
      summary.push({ status: 'failed', error: String(result.reason) });
      continue;
    }
    const { chunk, agentResults, mergedCode } = result.value;
    for (const ar of agentResults)
      writeFileSync(join(OUT_DIR, 'raw', `${chunk.name}-${ar.role.toLowerCase()}.txt`), ar.text, 'utf-8');
    writeFileSync(join(OUT_DIR, 'raw', `${chunk.name}-merged.txt`), mergedCode, 'utf-8');

    const files   = parseFiles(mergedCode, chunk);
    const written = [];
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(OUT_DIR, filename), content, 'utf-8');
      written.push(filename);
      console.log(`  ${join(OUT_DIR, filename)} (${content.length} chars)`);
    }
    summary.push({ chunk: chunk.name, status: 'ok', files: written });
  }

  savePlan(plan, { status: 'complete', elapsed: `${totalElapsed}s`, chunks: summary });
  writeFileSync(join(OUT_DIR, 'build-summary.json'), JSON.stringify({
    planTitle: plan.planTitle, ts: new Date().toISOString(),
    elapsed: `${totalElapsed}s`, model: MODEL, waves: waves.length, chunks: summary,
  }, null, 2), 'utf-8');

  console.log(`\n[DONE] ${totalElapsed}s total`);
  console.log(`Summary: ${join(OUT_DIR, 'build-summary.json')}`);
  console.log(`Resume:  --resume ${planPath}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
