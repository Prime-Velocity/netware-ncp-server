// SPDX-License-Identifier: Apache-2.0
// test-webhook-client.js  --  unit tests for ncp-webhook-client
//
// Tests run against mocked NCP and GitHub APIs.  No live server required.
// Run:  node test-webhook-client.js
'use strict';

const assert = require('assert');
const { extractRequests, verifySignature, isCivilianAllowed, formatResponse } = require('./ncp-webhook-client');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// extractRequests
// ---------------------------------------------------------------------------

console.log('\nextractRequests');

test('no fences -> empty array', () => {
  assert.deepStrictEqual(extractRequests('Hello, no NCP here.'), []);
});

test('single valid fence', () => {
  const body = '```ncp\n{"op":"getServerInfo"}\n```';
  const reqs = extractRequests(body);
  assert.strictEqual(reqs.length, 1);
  assert.strictEqual(reqs[0].op, 'getServerInfo');
});

test('multiple fences', () => {
  const body = [
    '```ncp\n{"op":"getServerInfo"}\n```',
    'some text',
    '```ncp\n{"op":"listDir","args":{"path":"SYS"}}\n```',
  ].join('\n');
  const reqs = extractRequests(body);
  assert.strictEqual(reqs.length, 2);
  assert.strictEqual(reqs[0].op, 'getServerInfo');
  assert.strictEqual(reqs[1].op, 'listDir');
  assert.strictEqual(reqs[1].args.path, 'SYS');
});

test('invalid JSON in fence -> parse error object', () => {
  const body = '```ncp\nnot json\n```';
  const reqs = extractRequests(body);
  assert.strictEqual(reqs.length, 1);
  assert.ok(reqs[0]._parseError, 'expected _parseError');
});

test('fence without op field -> not included', () => {
  const body = '```ncp\n{"foo":"bar"}\n```';
  const reqs = extractRequests(body);
  assert.strictEqual(reqs.length, 0, 'object without op should be excluded');
});

test('nonce is preserved', () => {
  const body = '```ncp\n{"op":"getServerTime","nonce":"xyz99"}\n```';
  const reqs = extractRequests(body);
  assert.strictEqual(reqs[0].nonce, 'xyz99');
});

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

console.log('\nverifySignature');

test('correct HMAC-SHA256 passes', () => {
  const crypto  = require('crypto');
  const secret  = 'mysecret';
  const body    = Buffer.from('{"action":"opened"}');
  const sig     = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  // Temporarily override config secret
  const orig = require('./ncp-webhook-client').CONFIG.webhookSecret;
  require('./ncp-webhook-client').CONFIG.webhookSecret = secret;
  assert.strictEqual(verifySignature(body, sig), true);
  require('./ncp-webhook-client').CONFIG.webhookSecret = orig;
});

test('wrong signature fails', () => {
  const crypto  = require('crypto');
  const secret  = 'mysecret';
  const body    = Buffer.from('{"action":"opened"}');
  const orig = require('./ncp-webhook-client').CONFIG.webhookSecret;
  require('./ncp-webhook-client').CONFIG.webhookSecret = secret;
  assert.strictEqual(verifySignature(body, 'sha256=deadbeef'), false);
  require('./ncp-webhook-client').CONFIG.webhookSecret = orig;
});

test('no secret configured -> always passes', () => {
  const orig = require('./ncp-webhook-client').CONFIG.webhookSecret;
  require('./ncp-webhook-client').CONFIG.webhookSecret = '';
  assert.strictEqual(verifySignature(Buffer.from('x'), null), true);
  require('./ncp-webhook-client').CONFIG.webhookSecret = orig;
});

// ---------------------------------------------------------------------------
// isCivilianAllowed
// ---------------------------------------------------------------------------

console.log('\nisCivilianAllowed');

test('empty allowlist -> everyone allowed', () => {
  const orig = require('./ncp-webhook-client').CONFIG.allowedCivilians;
  require('./ncp-webhook-client').CONFIG.allowedCivilians = [];
  assert.strictEqual(isCivilianAllowed('anyone'), true);
  require('./ncp-webhook-client').CONFIG.allowedCivilians = orig;
});

test('allowlist set -> only listed users pass', () => {
  const orig = require('./ncp-webhook-client').CONFIG.allowedCivilians;
  require('./ncp-webhook-client').CONFIG.allowedCivilians = ['bclark00', 'genesis-bot'];
  assert.strictEqual(isCivilianAllowed('bclark00'), true);
  assert.strictEqual(isCivilianAllowed('genesis-bot'), true);
  assert.strictEqual(isCivilianAllowed('stranger'), false);
  require('./ncp-webhook-client').CONFIG.allowedCivilians = orig;
});

// ---------------------------------------------------------------------------
// formatResponse
// ---------------------------------------------------------------------------

console.log('\nformatResponse');

test('success result contains JSON block', () => {
  const results = [{ ok: true, op: 'getServerInfo', nonce: 'n1', result: { name: 'GENESIS-SRV', version: '3.12' } }];
  const out = formatResponse({}, results);
  assert.ok(out.includes('getServerInfo'), 'should mention op');
  assert.ok(out.includes('GENESIS-SRV'), 'should contain result data');
  assert.ok(out.includes('```json'), 'should have json fence');
});

test('error result shows error message', () => {
  const results = [{ ok: false, op: 'listDir', nonce: null, error: 'File not found: SYS/MISSING' }];
  const out = formatResponse({}, results);
  assert.ok(out.includes('listDir'));
  assert.ok(out.includes('File not found: SYS/MISSING'));
});

test('parse error shown distinctly', () => {
  const results = [{ _parseError: 'Unexpected token x', _raw: 'not json' }];
  const out = formatResponse({}, results);
  assert.ok(out.includes('Parse error'));
  assert.ok(out.includes('Unexpected token x'));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
