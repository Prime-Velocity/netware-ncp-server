/**
 * provider-mux.mjs
 * ================
 * Node.js port of ProviderMultiplexer.cs
 *
 * All credentials loaded from vault (~/.secrets via vault.mjs).
 * Never pass API keys as env vars or CLI args — vault only.
 *
 * Chain (priority order): anthropic -> gemini -> openai -> xai
 * 429 = immediate fallback to next provider, no delay.
 *
 * Export:
 *   muxCall({ system, prompt, maxTokens }) -> Promise<string>
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join }    from 'path';

// ── Vault (inline — no circular dep, same logic as vault.mjs vaultGet) ────────

function vaultRead() {
  const p = join(homedir(), '.secrets');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

// Cache vault once per process
let _vault = null;
function vault() { return _vault ??= vaultRead(); }

// Env-first, then vault — same semantics as vault.mjs vaultGet()
function vaultGet(key) { return process.env[key] || vault()[key] || null; }

// ── CircuitBreaker ────────────────────────────────────────────────────────────

class CircuitBreaker {
  constructor(id, opts = {}) {
    this.id               = id;
    this.failureThreshold = opts.failureThreshold  ?? 3;
    this.windowMs         = (opts.samplingWindowSec ?? 60) * 1000;
    this.openDurationMs   = (opts.openDurationSec   ?? 45) * 1000;
    this.halfOpenProbes   = opts.halfOpenProbes      ?? 1;
    this._state           = 'closed';
    this._failures        = 0;
    this._windowStart     = Date.now();
    this._openedAt        = 0;
    this._probesSent      = 0;
  }

  get state() { return this._state; }

  allowRequest() {
    if (this._state === 'closed') return true;
    if (this._state === 'open') {
      if (Date.now() - this._openedAt >= this.openDurationMs) {
        this._tx('half-open');
        this._probesSent = 0;
      } else return false;
    }
    return this._probesSent++ < this.halfOpenProbes;
  }

  recordSuccess() { this._failures = 0; if (this._state !== 'closed') this._tx('closed'); }

  recordFailure() {
    if (Date.now() - this._windowStart > this.windowMs) { this._failures = 0; this._windowStart = Date.now(); }
    this._failures++;
    if (this._state === 'half-open' || this._failures >= this.failureThreshold) this._tx('open');
  }

  _tx(next) {
    if (this._state === next) return;
    console.error(`[CB:${this.id}] ${this._state} -> ${next}`);
    this._state = next;
    if (next === 'open') this._openedAt = Date.now();
  }
}

// ── TelemetryStore ────────────────────────────────────────────────────────────

class TelemetryStore {
  constructor() { this._s = new Map(); }

  _get(id) {
    if (!this._s.has(id)) this._s.set(id, { id, total:0, ok:0, fail:0, cost:0, lat:[] });
    return this._s.get(id);
  }

  recordSuccess(id, ms, cost=0) {
    const s = this._get(id); s.total++; s.ok++; s.cost += cost;
    s.lat.push(ms); if (s.lat.length > 200) s.lat.shift();
  }

  recordFailure(id, ms) {
    const s = this._get(id); s.total++; s.fail++;
    s.lat.push(ms); if (s.lat.length > 200) s.lat.shift();
  }

  // successRate*0.5 + latencyRank*0.3 + costRank*0.2
  routingScore(id) {
    const all = [...this._s.values()];
    if (!all.length) return 1.0;
    const s   = this._get(id);
    const p50 = arr => arr.length ? [...arr].sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] : 0;

    const successRate = s.total ? s.ok / s.total : 1.0;
    const lats     = all.map(x => p50(x.lat)).sort((a,b)=>a-b);
    const latRank  = lats.length > 1 ? 1 - lats.indexOf(p50(s.lat)) / (lats.length-1) : 1.0;
    const costs    = all.map(x => x.cost).sort((a,b)=>a-b);
    const costRank = costs.length > 1 ? 1 - costs.indexOf(s.cost) / (costs.length-1) : 1.0;

    return successRate*0.5 + latRank*0.3 + costRank*0.2;
  }

  snapshot() {
    return [...this._s.values()].map(s => ({
      id: s.id, total: s.total, ok: s.ok, fail: s.fail,
      rate: s.total ? (s.ok/s.total).toFixed(3) : 'n/a',
      score: this.routingScore(s.id).toFixed(3),
    }));
  }
}

// ── Provider call functions ───────────────────────────────────────────────────

const rateLimit = () => Object.assign(new Error('rate_limit'), { isRateLimit: true });

async function callAnthropic({ apiKey, model, system, messages, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model: model ?? 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages }),
  });
  if (res.status === 429) throw rateLimit();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0,200)}`);
  const d = await res.json();
  return { text: d.content?.[0]?.text ?? '', in: d.usage?.input_tokens??0, out: d.usage?.output_tokens??0 };
}

async function callGemini({ apiKey, model, system, messages, maxTokens }) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model ?? 'gemini-1.5-flash'}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts:[{ text:system }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  );
  if (res.status === 429) throw rateLimit();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0,200)}`);
  const d = await res.json();
  return {
    text: d.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    in:   d.usageMetadata?.promptTokenCount     ?? 0,
    out:  d.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callOpenAI({ apiKey, model, system, messages, maxTokens }) {
  const msgs = [...(system ? [{role:'system',content:system}] : []), ...messages];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model: model ?? 'gpt-4o-mini', max_tokens: maxTokens, messages: msgs }),
  });
  if (res.status === 429) throw rateLimit();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0,200)}`);
  const d = await res.json();
  return { text: d.choices?.[0]?.message?.content ?? '', in: d.usage?.prompt_tokens??0, out: d.usage?.completion_tokens??0 };
}

async function callXAI({ apiKey, model, system, messages, maxTokens }) {
  const msgs = [...(system ? [{role:'system',content:system}] : []), ...messages];
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model: model ?? 'grok-beta', max_tokens: maxTokens, messages: msgs }),
  });
  if (res.status === 429) throw rateLimit();
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0,200)}`);
  const d = await res.json();
  return { text: d.choices?.[0]?.message?.content ?? '', in: d.usage?.prompt_tokens??0, out: d.usage?.completion_tokens??0 };
}

const COST_PER_1M = {
  anthropic: { in:3.00,  out:15.00 },
  gemini:    { in:0.075, out:0.30  },
  openai:    { in:0.15,  out:0.60  },
  xai:       { in:5.00,  out:15.00 },
};

// ── ProviderMux ───────────────────────────────────────────────────────────────

class ProviderMux {
  constructor() {
    // All credentials from vault — no env var injection required
    const defs = [
      { id:'anthropic', fn:callAnthropic, vaultKey:'ANTHROPIC_API_KEY',  model: vaultGet('GENESIS_MODEL') ?? 'claude-sonnet-4-20250514' },
      { id:'gemini',    fn:callGemini,    vaultKey:'GEMINI_API_KEY',      model:'gemini-1.5-flash' },
      { id:'openai',    fn:callOpenAI,    vaultKey:'OPENAI_API_KEY',      model:'gpt-4o-mini' },
      { id:'xai',       fn:callXAI,       vaultKey:'XAI_API_KEY',         model:'grok-beta' },
    ];

    this._providers = defs
      .map(d => ({ ...d, apiKey: vaultGet(d.vaultKey) }))
      .filter(p => p.apiKey);

    if (!this._providers.length)
      throw new Error('[MUX] No API keys found in vault (~/.secrets). Run: node ~/tool-cdn/vault.mjs list');

    // Priority chain: explicit order, skip missing providers
    this._chain    = ['anthropic','gemini','openai','xai'].filter(id => this._providers.some(p => p.id === id));
    this._tel      = new TelemetryStore();
    this._breakers = new Map(this._providers.map(p => [p.id, new CircuitBreaker(p.id)]));

    console.error(`[MUX] loaded ${this._providers.length} provider(s) from vault: ${this._providers.map(p=>p.id).join(', ')}`);
    console.error(`[MUX] chain: ${this._chain.join(' -> ')}`);
  }

  // Returns plain text string
  async call({ system, messages, maxTokens = 8000 }) {
    let lastErr;
    for (const id of this._chain) {
      const p       = this._providers.find(x => x.id === id);
      const breaker = this._breakers.get(id);
      if (!p || !breaker.allowRequest()) {
        console.error(`[MUX] ${id} skipped (circuit: ${breaker?.state ?? 'n/a'})`);
        continue;
      }

      const t0 = Date.now();
      try {
        const result = await p.fn({ apiKey:p.apiKey, model:p.model, system, messages, maxTokens });
        const ms     = Date.now() - t0;
        const cost   = ((result.in*(COST_PER_1M[id]?.in??1)) + (result.out*(COST_PER_1M[id]?.out??1))) / 1e6;
        breaker.recordSuccess();
        this._tel.recordSuccess(id, ms, cost);
        console.error(`[MUX] ${id} ok ${ms}ms ~$${cost.toFixed(5)}`);
        return result.text;
      } catch(err) {
        const ms = Date.now() - t0;
        breaker.recordFailure();
        this._tel.recordFailure(id, ms);
        console.error(`[MUX] ${id} failed (${err.isRateLimit ? '429 rate-limit' : err.message}) -> next`);
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('[MUX] All providers failed');
  }

  stats()          { return this._tel.snapshot(); }
  breakerStates()  { return Object.fromEntries([...this._breakers.entries()].map(([id,b])=>[id,b.state])); }
}

let _mux = null;
function getMux() { return _mux ??= new ProviderMux(); }

/**
 * muxCall({ system, prompt, maxTokens }) -> Promise<string>
 * Drop-in for genesis-orchestrator's claudeCall() fetch block.
 * Credentials loaded from vault automatically.
 */
export async function muxCall({ system, prompt, maxTokens = 8000 }) {
  return getMux().call({ system, messages:[{ role:'user', content:prompt }], maxTokens });
}

export { ProviderMux, getMux, vaultGet };
