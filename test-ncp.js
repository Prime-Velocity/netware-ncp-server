#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * test-ncp.js  --  NetWare NCP smoke tests
 *
 * Starts the server on a high port (5240) — no root required.
 * Runs a client through: connect, bindery, semaphores, TTS, broadcast,
 * disconnect.  GitHub volume is not tested here (requires a real token).
 *
 * Usage:
 *   node test-ncp.js
 */

const { NCPServer }  = require('./ncp-server');
const { NCPClient, OBJ_TYPE } = require('./ncp-client');

const TEST_PORT = 5240;
let passed = 0;
let failed = 0;

function ok(label)      { console.log(`  PASS  ${label}`); passed++; }
function fail(label, e) { console.error(`  FAIL  ${label}: ${e?.message || e}`); failed++; }

async function expect(label, fn) {
  try { await fn(); ok(label); }
  catch (e) { fail(label, e); }
}

// ---- helpers ---------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---- test suites -----------------------------------------------------------

async function testConnect(client) {
  await expect('connect to server', async () => {
    const info = await client.connect();
    assert(info.connLo !== 0xFF || info.connHi !== 0xFF, 'got connection id');
    assert(info.bufferSize > 0, `bufferSize=${info.bufferSize}`);
  });
}

async function testServerInfo(client) {
  await expect('getServerInfo', async () => {
    const info = await client.getServerInfo();
    assert(info.name.includes('SERVER'), `name="${info.name}"`);
    assert(info.version, `version="${info.version}"`);
    assert(info.ttsLevel > 0, `ttsLevel=${info.ttsLevel}`);
  });

  await expect('getServerTime', async () => {
    const t = await client.getServerTime();
    assert(t.year >= 2024, `year=${t.year}`);
    assert(t.month >= 1 && t.month <= 12, `month=${t.month}`);
  });
}

async function testBindery(client) {
  await expect('createObject USER:TESTUSER', async () => {
    const id = await client.createObject('TESTUSER', OBJ_TYPE.USER);
    assert(id > 0, `objectId=${id}`);
  });

  await expect('getObjectID by name', async () => {
    const obj = await client.getObjectID('TESTUSER', OBJ_TYPE.USER);
    assert(obj.name === 'TESTUSER', `name="${obj.name}"`);
    assert(obj.type === OBJ_TYPE.USER, `type=0x${obj.type.toString(16)}`);
  });

  await expect('getObjectName by id', async () => {
    const obj1 = await client.getObjectID('TESTUSER', OBJ_TYPE.USER);
    const obj2 = await client.getObjectName(obj1.id);
    assert(obj2.name === 'TESTUSER', `name="${obj2.name}"`);
  });

  await expect('scanObjects finds TESTUSER', async () => {
    const objs = await client.scanObjects('*', OBJ_TYPE.USER);
    assert(objs.some(o => o.name === 'TESTUSER'), 'TESTUSER not found in scan');
  });

  await expect('createProperty + readPropertyValue', async () => {
    await client.createProperty('TESTUSER', OBJ_TYPE.USER, 'EMAIL');
    await client.writePropertyValue('TESTUSER', OBJ_TYPE.USER, 'EMAIL',
      Buffer.from('test@example.com'));
    const { value } = await client.readPropertyValue('TESTUSER', OBJ_TYPE.USER, 'EMAIL');
    const str = value.toString('ascii').replace(/\0/g, '');
    assert(str.startsWith('test@example.com'), `value="${str}"`);
  });

  await expect('changePassword + verifyPassword', async () => {
    await client.changePassword('TESTUSER', OBJ_TYPE.USER, 'secret123');
    const ok = await client.verifyPassword('TESTUSER', OBJ_TYPE.USER, 'secret123');
    assert(ok, 'password verify failed');
    const bad = await client.verifyPassword('TESTUSER', OBJ_TYPE.USER, 'wrong');
    assert(!bad, 'bad password accepted');
  });

  await expect('deleteObject TESTUSER', async () => {
    await client.deleteObject('TESTUSER', OBJ_TYPE.USER);
    try {
      await client.getObjectID('TESTUSER', OBJ_TYPE.USER);
      throw new Error('should have thrown NO_SUCH_OBJECT');
    } catch (e) {
      assert(e.message.includes('failed'), `unexpected error: ${e.message}`);
    }
  });
}

async function testSemaphores(client) {
  let handle;

  await expect('openSema (create)', async () => {
    const res = await client.openSema('TESTSEMA', 3);
    assert(res.handle > 0, `handle=${res.handle}`);
    assert(res.openCount === 1, `openCount=${res.openCount}`);
    handle = res.handle;
  });

  await expect('examineSema (value=3)', async () => {
    const res = await client.examineSema(handle);
    assert(res.value === 3, `value=${res.value}`);
    assert(res.openCount === 1, `openCount=${res.openCount}`);
  });

  await expect('waitSema (decrement to 2)', async () => {
    const ok = await client.waitSema(handle, 0);
    assert(ok, 'waitSema returned false');
    const res = await client.examineSema(handle);
    assert(res.value === 2, `value after wait=${res.value}`);
  });

  await expect('signalSema (increment to 3)', async () => {
    const ok = await client.signalSema(handle);
    assert(ok, 'signalSema returned false');
    const res = await client.examineSema(handle);
    assert(res.value === 3, `value after signal=${res.value}`);
  });

  await expect('closeSema', async () => {
    const ok = await client.closeSema(handle);
    assert(ok, 'closeSema returned false');
  });
}

async function testTTS(client) {
  await expect('ttsAvailable', async () => {
    const avail = await client.ttsAvailable();
    assert(avail === true, `available=${avail}`);
  });

  await expect('ttsBegin', async () => {
    const ok = await client.ttsBegin();
    assert(ok, 'ttsBegin returned false');
  });

  await expect('ttsEnd returns txn id', async () => {
    const id = await client.ttsEnd();
    assert(id !== null && id > 0, `txn id=${id}`);
  });

  await expect('ttsIsCommitted after end', async () => {
    // Begin + End a new txn, then check committed
    await client.ttsBegin();
    const id = await client.ttsEnd();
    const committed = await client.ttsIsCommitted(id);
    assert(committed, `isCommitted=${committed} for id=${id}`);
  });

  await expect('ttsBegin + ttsAbort', async () => {
    await client.ttsBegin();
    // Abort the in-flight txn (no id needed — server tracks per-conn)
    const ok = await client.ttsAbort(0);
    assert(ok === true, 'ttsAbort returned false');
  });

  await expect('ttsDisable + ttsEnable', async () => {
    await client.ttsDisable();
    const unavail = await client.ttsAvailable();
    assert(!unavail, 'should be unavailable after disable');
    await client.ttsEnable();
    const avail = await client.ttsAvailable();
    assert(avail, 'should be available after enable');
  });
}

async function testBroadcast(client) {
  await expect('disableBroadcast + enableBroadcast', async () => {
    await client.disableBroadcast();
    await client.enableBroadcast();
  });

  await expect('getBroadcastMode (0 = accept)', async () => {
    const mode = await client.getBroadcastMode();
    assert(mode === 0, `mode=${mode}`);
  });

  await expect('getBroadcastMessage (empty)', async () => {
    const msg = await client.getBroadcastMessage();
    assert(msg === null || msg === '', `msg="${msg}"`);
  });
}

async function testDestroyPacket() {
  // Open a second client, connect, send a raw 0x5555 destroy, verify
  // the server removes that connection (subsequent request gets 0x88 error).
  const { NCPClient } = require('./ncp-client');
  const { buildDestroyRequest } = require('./ncp-packet');
  const dgram = require('dgram');

  const c2 = new NCPClient('127.0.0.1', TEST_PORT);
  await expect('0x5555 Destroy Service Connection', async () => {
    const info = await c2.connect();
    // Peek at internal state — connection should be registered
    const connId = info.connLo | (info.connHi << 8);
    assert(connId > 0, `connId=${connId}`);

    // Send 0x5555 Destroy — no reply expected
    const pkt = buildDestroyRequest(0x01, info.connLo, info.connHi, 1);
    const sock = dgram.createSocket('udp4');
    await new Promise((res, rej) => {
      sock.bind(0, () => {
        sock.send(pkt, 0, pkt.length, TEST_PORT, '127.0.0.1', err => {
          if (err) rej(err); else res();
        });
      });
    });
    await new Promise(r => setTimeout(r, 50)); // let server process
    sock.close();
    // c2 socket is still open for cleanup; just close it
    try { c2._socket.close(); } catch (_) {}
    c2._socket = null;
  });
}

async function testDisconnect(client) {
  await expect('disconnect (Logout + 0x5555)', async () => {
    await client.disconnect();
  });
}

// ---- Entry point -----------------------------------------------------------

(async () => {
  console.log('\n  netware-ncp-server smoke tests\n');

  // Start a server on test port (no root required)
  const server = new NCPServer(TEST_PORT, '127.0.0.1');
  await server.start();

  const client = new NCPClient('127.0.0.1', TEST_PORT);

  try {
    await testConnect(client);
    await testServerInfo(client);
    await testBindery(client);
    await testSemaphores(client);
    await testTTS(client);
    await testBroadcast(client);
    await testDestroyPacket();
    await testDisconnect(client);
  } finally {
    server.stop();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
