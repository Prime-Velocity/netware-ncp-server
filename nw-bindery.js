// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Genesis Systems (a dba of Exponential Systems)
'use strict';
/**
 * nw-bindery.js  --  In-memory Bindery
 *
 * Ported from TurboPower BTF NWBind.PAS
 *
 * The NetWare Bindery is an NDS predecessor — essentially a flat-file
 * network directory storing objects (users, groups, servers, queues)
 * and their properties (password hashes, group membership sets, etc.)
 *
 * Original Pascal structures:
 *   TnwPropValue = array[1..128] of char  (item)
 *                | array[1..32] of nwLong (set)
 *
 * We store:
 *   objects[id] = { id, type, name, flags, security, properties: {} }
 *   properties[name] = { value: Buffer[128], flags, security, type }
 *     where type = 'item' | 'set'
 *     and for 'set', value is an array of object IDs (nwLong each = 4 bytes)
 */

const { ERR, BIND_SUB, OBJ_TYPE } = require('./ncp-packet');

const PROP_VALUE_SIZE = 128;   // bytes per property value segment

class Bindery {
  constructor() {
    this._objects   = new Map();  // id -> object record
    this._byName    = new Map();  // "type:NAME" -> id
    this._nextId    = 1;
    this._locked    = false;

    // Pre-populate a file server entry — every NetWare server has one
    this._addBuiltin('NODEJS-SERVER', OBJ_TYPE.FILE_SERVER, 0x00, 0x31);
    // Add a supervisor user
    this._addBuiltin('SUPERVISOR', OBJ_TYPE.USER, 0x00, 0x31);
  }

  _addBuiltin(name, type, flags, security) {
    const id  = this._nextId++;
    const rec = { id, type, name: name.toUpperCase(), flags, security, properties: {} };
    this._objects.set(id, rec);
    this._byName.set(`${type}:${rec.name}`, id);
    return id;
  }

  _key(name, type) {
    return `${type}:${name.toUpperCase()}`;
  }

  _findObj(name, type) {
    // type 0xFFFF = wildcard
    if (type === OBJ_TYPE.WILD) {
      for (const [k, id] of this._byName) {
        if (k.endsWith(':' + name.toUpperCase())) return this._objects.get(id);
      }
      return null;
    }
    const id = this._byName.get(this._key(name, type));
    return id ? this._objects.get(id) : null;
  }

  // ---- NCP handler dispatch ------------------------------------------------

  handle(subFunc, data) {
    if (this._locked && subFunc !== BIND_SUB.OPEN_BINDERY) {
      return { err: ERR.BINDERY_LOCKED, reply: null };
    }
    switch (subFunc) {
      case BIND_SUB.CREATE_OBJECT:        return this.createObject(data);
      case BIND_SUB.DELETE_OBJECT:        return this.deleteObject(data);
      case BIND_SUB.RENAME_OBJECT:        return this.renameObject(data);
      case BIND_SUB.GET_OBJECT_ID:        return this.getObjectID(data);
      case BIND_SUB.GET_OBJECT_NAME:      return this.getObjectName(data);
      case BIND_SUB.SCAN_OBJECT:          return this.scanObject(data);
      case BIND_SUB.CHANGE_OBJ_SECURITY:  return this.changeObjSecurity(data);
      case BIND_SUB.CREATE_PROPERTY:      return this.createProperty(data);
      case BIND_SUB.DELETE_PROPERTY:      return this.deleteProperty(data);
      case BIND_SUB.SCAN_PROPERTY:        return this.scanProperty(data);
      case BIND_SUB.READ_PROPERTY_VALUE:  return this.readPropertyValue(data);
      case BIND_SUB.WRITE_PROPERTY_VALUE: return this.writePropertyValue(data);
      case BIND_SUB.VERIFY_PASSWORD:      return this.verifyPassword(data);
      case BIND_SUB.CHANGE_PASSWORD:      return this.changePassword(data);
      case BIND_SUB.ADD_OBJ_TO_SET:       return this.addObjToSet(data);
      case BIND_SUB.DELETE_OBJ_FROM_SET:  return this.deleteObjFromSet(data);
      case BIND_SUB.IS_OBJ_IN_SET:        return this.isObjInSet(data);
      case BIND_SUB.OPEN_BINDERY:         return this.openBindery();
      case BIND_SUB.CLOSE_BINDERY:        return this.closeBindery();
      case BIND_SUB.GET_BINDERY_ACCESS:   return this.getBinderyAccess();
      case BIND_SUB.GET_SERVER_INFO:      return this.getServerInfo();
      case BIND_SUB.GET_SERVER_TIME:      return this.getServerTime();
      case BIND_SUB.GET_CONN_INFO:        return this.getConnInfo(data);
      default:
        return { err: ERR.BAD_DATA, reply: null };
    }
  }

  // ---- Bindery operations (directly matching NWBind.PAS) ------------------

  createObject(data) {
    // Request layout (from nwbCreateObject):
    //   [0]   flags     : byte
    //   [1]   security  : byte
    //   [2-3] objType   : word (big-endian)
    //   [4]   nameLen   : byte
    //   [5..] name
    let off = 0;
    const flags    = data[off++];
    const security = data[off++];
    const objType  = data.readUInt16BE(off); off += 2;
    const nameLen  = data[off++];
    const name     = data.slice(off, off + nameLen).toString('ascii').toUpperCase();

    if (this._findObj(name, objType)) return { err: ERR.OBJECT_EXISTS, reply: null };

    const id  = this._nextId++;
    const rec = { id, type: objType, name, flags, security, properties: {} };
    this._objects.set(id, rec);
    this._byName.set(this._key(name, objType), id);

    const reply = Buffer.alloc(4);
    reply.writeUInt32BE(id, 0);
    return { err: ERR.SUCCESS, reply };
  }

  deleteObject(data) {
    let off = 0;
    const objType = data.readUInt16BE(off); off += 2;
    const nameLen = data[off++];
    const name    = data.slice(off, off + nameLen).toString('ascii').toUpperCase();

    const obj = this._findObj(name, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    this._objects.delete(obj.id);
    this._byName.delete(this._key(name, objType));
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  renameObject(data) {
    let off = 0;
    const objType    = data.readUInt16BE(off); off += 2;
    const oldNameLen = data[off++];
    const oldName    = data.slice(off, off + oldNameLen).toString('ascii').toUpperCase(); off += oldNameLen;
    const newNameLen = data[off++];
    const newName    = data.slice(off, off + newNameLen).toString('ascii').toUpperCase();

    const obj = this._findObj(oldName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    if (this._findObj(newName, objType)) return { err: ERR.OBJECT_EXISTS, reply: null };

    this._byName.delete(this._key(oldName, objType));
    obj.name = newName;
    this._byName.set(this._key(newName, objType), obj.id);
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  getObjectID(data) {
    // [0-1] type, [2] nameLen, [3..] name
    const objType = data.readUInt16BE(0);
    const nameLen = data[2];
    const name    = data.slice(3, 3 + nameLen).toString('ascii').toUpperCase();

    const obj = this._findObj(name, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    const reply = Buffer.alloc(54);
    reply.writeUInt32BE(obj.id, 0);
    reply.writeUInt16BE(obj.type, 4);
    // 48 bytes for name, NUL-padded
    Buffer.from(obj.name, 'ascii').copy(reply, 6);
    return { err: ERR.SUCCESS, reply };
  }

  getObjectName(data) {
    // [0-3] objectID
    const id  = data.readUInt32BE(0);
    const obj = this._objects.get(id);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    const reply = Buffer.alloc(54);
    reply.writeUInt32BE(obj.id, 0);
    reply.writeUInt16BE(obj.type, 4);
    Buffer.from(obj.name, 'ascii').copy(reply, 6);
    return { err: ERR.SUCCESS, reply };
  }

  scanObject(data) {
    // [0-3] lastID (0xFFFFFFFF = start), [4-5] objType, [6] nameLen, [7..] name pattern
    const lastId  = data.readUInt32BE(0);
    const objType = data.readUInt16BE(4);
    const nameLen = data[6];
    const pattern = data.slice(7, 7 + nameLen).toString('ascii').toUpperCase();

    // Simple wildcard: '*' matches everything
    const matchName = (name) => {
      if (pattern === '*') return true;
      if (!pattern.includes('*')) return name === pattern;
      const parts = pattern.split('*');
      let pos = 0;
      for (const p of parts) {
        if (!p) continue;
        const i = name.indexOf(p, pos);
        if (i === -1) return false;
        pos = i + p.length;
      }
      return true;
    };

    // Find next object after lastId that matches
    for (const [id, obj] of this._objects) {
      if (id <= lastId) continue;
      if (objType !== OBJ_TYPE.WILD && obj.type !== objType) continue;
      if (!matchName(obj.name)) continue;

      const reply = Buffer.alloc(57);
      reply.writeUInt32BE(obj.id, 0);
      reply.writeUInt16BE(obj.type, 4);
      Buffer.from(obj.name, 'ascii').copy(reply, 6);
      reply[54] = obj.flags;
      reply[55] = obj.security;
      reply[56] = 0x00; // object properties exist flag
      return { err: ERR.SUCCESS, reply };
    }

    return { err: ERR.NO_SUCH_OBJECT, reply: null };
  }

  changeObjSecurity(data) {
    const objType = data.readUInt16BE(0);
    const nameLen = data[2];
    const name    = data.slice(3, 3 + nameLen).toString('ascii').toUpperCase();
    const newSec  = data[3 + nameLen];

    const obj = this._findObj(name, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    obj.security = newSec;
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  createProperty(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const propFlags= data[off++];
    const propSec  = data[off++];
    const propNameL= data[off++];
    const propName = data.slice(off, off + propNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    if (obj.properties[propName]) return { err: ERR.PROPERTY_EXISTS, reply: null };

    obj.properties[propName] = {
      flags   : propFlags,
      security: propSec,
      value   : Buffer.alloc(PROP_VALUE_SIZE, 0),
      type    : (propFlags & 0x02) ? 'set' : 'item',
    };
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  deleteProperty(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const propNameL= data[off++];
    const propName = data.slice(off, off + propNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    if (!obj.properties[propName]) return { err: ERR.NO_SUCH_PROPERTY, reply: null };

    delete obj.properties[propName];
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  scanProperty(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const lastSeq  = data.readInt32BE(off); off += 4;   // -1 = start
    const propNameL= data[off++];
    const pattern  = data.slice(off, off + propNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    const names = Object.keys(obj.properties).filter(n =>
      pattern === '*' || n === pattern
    );

    const idx = lastSeq < 0 ? 0 : (names.indexOf(/* last seen */ '') + 1);
    if (idx >= names.length) return { err: ERR.NO_SUCH_PROPERTY, reply: null };

    const propName = names[idx];
    const prop = obj.properties[propName];
    const reply = Buffer.alloc(24);
    Buffer.from(propName, 'ascii').copy(reply, 0);  // 16 bytes, NUL padded
    reply[16] = prop.flags;
    reply[17] = prop.security;
    reply.writeInt32BE(idx, 18);  // sequence
    reply[22] = names.length > idx + 1 ? 0xFF : 0x00;  // more properties
    reply[23] = prop.type === 'set' ? 0x02 : 0x00;
    return { err: ERR.SUCCESS, reply };
  }

  readPropertyValue(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const segment  = data[off++];  // 1-based segment index (128 bytes each)
    const propNameL= data[off++];
    const propName = data.slice(off, off + propNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    const prop = obj.properties[propName];
    if (!prop) return { err: ERR.NO_SUCH_PROPERTY, reply: null };

    const reply = Buffer.alloc(130);
    prop.value.copy(reply, 0, 0, PROP_VALUE_SIZE);
    reply[128] = 0x00; // more segments flag
    reply[129] = prop.flags;
    return { err: ERR.SUCCESS, reply };
  }

  writePropertyValue(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const segment  = data[off++];
    const erase    = data[off++];
    const propNameL= data[off++];
    const propName = data.slice(off, off + propNameL).toString('ascii').toUpperCase(); off += propNameL;
    const value    = data.slice(off, off + PROP_VALUE_SIZE);

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    const prop = obj.properties[propName];
    if (!prop) return { err: ERR.NO_SUCH_PROPERTY, reply: null };

    value.copy(prop.value, 0);
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  verifyPassword(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const pwdLen   = data[off++];
    const pwd      = data.slice(off, off + pwdLen).toString('ascii');

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    const prop = obj.properties['PASSWORD'];
    const stored = prop ? prop.value.slice(0, pwdLen).toString('ascii') : '';
    if (stored !== pwd) return { err: ERR.BAD_PASSWORD, reply: null };
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  changePassword(data) {
    let off = 0;
    const objType  = data.readUInt16BE(off); off += 2;
    const objNameL = data[off++];
    const objName  = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const newPwdL  = data[off++];
    const newPwd   = data.slice(off, off + newPwdL).toString('ascii');

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    if (!obj.properties['PASSWORD']) {
      obj.properties['PASSWORD'] = {
        flags: 0x00, security: 0x31,
        value: Buffer.alloc(PROP_VALUE_SIZE, 0), type: 'item',
      };
    }
    Buffer.from(newPwd, 'ascii').copy(obj.properties['PASSWORD'].value);
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  addObjToSet(data) {
    let off = 0;
    const objType   = data.readUInt16BE(off); off += 2;
    const objNameL  = data[off++];
    const objName   = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const propNameL = data[off++];
    const propName  = data.slice(off, off + propNameL).toString('ascii').toUpperCase(); off += propNameL;
    const memType   = data.readUInt16BE(off); off += 2;
    const memNameL  = data[off++];
    const memName   = data.slice(off, off + memNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    const prop = obj.properties[propName];
    if (!prop || prop.type !== 'set') return { err: ERR.NO_SUCH_PROPERTY, reply: null };

    const member = this._findObj(memName, memType);
    if (!member) return { err: ERR.NO_SUCH_OBJECT, reply: null };

    // Set is 32 x nwLong (128 bytes), each entry is a 4-byte object ID
    for (let i = 0; i < 32; i++) {
      const id = prop.value.readUInt32BE(i * 4);
      if (id === member.id) return { err: ERR.SUCCESS, reply: Buffer.alloc(0) }; // already in set
      if (id === 0) { prop.value.writeUInt32BE(member.id, i * 4); break; }
    }
    return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
  }

  deleteObjFromSet(data) {
    let off = 0;
    const objType   = data.readUInt16BE(off); off += 2;
    const objNameL  = data[off++];
    const objName   = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const propNameL = data[off++];
    const propName  = data.slice(off, off + propNameL).toString('ascii').toUpperCase(); off += propNameL;
    const memType   = data.readUInt16BE(off); off += 2;
    const memNameL  = data[off++];
    const memName   = data.slice(off, off + memNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    const prop = obj.properties[propName];
    if (!prop || prop.type !== 'set') return { err: ERR.NO_SUCH_PROPERTY, reply: null };

    const member = this._findObj(memName, memType);
    if (!member) return { err: ERR.NO_SUCH_MEMBER, reply: null };

    for (let i = 0; i < 32; i++) {
      if (prop.value.readUInt32BE(i * 4) === member.id) {
        // Compact — shift remaining entries up
        for (let j = i; j < 31; j++)
          prop.value.writeUInt32BE(prop.value.readUInt32BE((j + 1) * 4), j * 4);
        prop.value.writeUInt32BE(0, 31 * 4);
        return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };
      }
    }
    return { err: ERR.NO_SUCH_MEMBER, reply: null };
  }

  isObjInSet(data) {
    let off = 0;
    const objType   = data.readUInt16BE(off); off += 2;
    const objNameL  = data[off++];
    const objName   = data.slice(off, off + objNameL).toString('ascii').toUpperCase(); off += objNameL;
    const propNameL = data[off++];
    const propName  = data.slice(off, off + propNameL).toString('ascii').toUpperCase(); off += propNameL;
    const memType   = data.readUInt16BE(off); off += 2;
    const memNameL  = data[off++];
    const memName   = data.slice(off, off + memNameL).toString('ascii').toUpperCase();

    const obj = this._findObj(objName, objType);
    if (!obj) return { err: ERR.NO_SUCH_OBJECT, reply: null };
    const prop = obj.properties[propName];
    if (!prop || prop.type !== 'set') return { err: ERR.NO_SUCH_PROPERTY, reply: null };
    const member = this._findObj(memName, memType);
    if (!member) return { err: ERR.NO_SUCH_MEMBER, reply: null };

    for (let i = 0; i < 32; i++)
      if (prop.value.readUInt32BE(i * 4) === member.id)
        return { err: ERR.SUCCESS, reply: Buffer.alloc(0) };

    return { err: ERR.NO_SUCH_MEMBER, reply: null };
  }

  openBindery()   { this._locked = false; return { err: ERR.SUCCESS, reply: Buffer.alloc(0) }; }
  closeBindery()  { this._locked = true;  return { err: ERR.SUCCESS, reply: Buffer.alloc(0) }; }
  getBinderyAccess() {
    const reply = Buffer.alloc(2);
    reply[0] = 0x31; // read/write
    reply[1] = 0x31;
    return { err: ERR.SUCCESS, reply };
  }

  getServerInfo() {
    // TnwServerInfo struct from NWConn.PAS
    const reply = Buffer.alloc(128);
    Buffer.from('NODEJS-SERVER', 'ascii').copy(reply, 0);
    reply[48] = 3;    // NetWare major version
    reply[49] = 12;   // minor
    reply.writeUInt16BE(1000, 50); // max connections
    reply.writeUInt16BE(1,    52); // used connections
    reply.writeUInt16BE(32,   54); // max volumes
    reply[56] = 0;    // revision
    reply[57] = 3;    // SFT level
    reply[58] = 1;    // TTS level
    return { err: ERR.SUCCESS, reply };
  }

  getServerTime() {
    const now = new Date();
    const reply = Buffer.alloc(7);
    reply[0] = now.getFullYear() - 1980; // packed year
    reply[1] = now.getMonth() + 1;
    reply[2] = now.getDate();
    reply[3] = now.getHours();
    reply[4] = now.getMinutes();
    reply[5] = now.getSeconds();
    reply[6] = now.getDay();
    return { err: ERR.SUCCESS, reply };
  }

  getConnInfo(data) {
    // [0-1] connNo
    const reply = Buffer.alloc(62);
    reply.writeUInt32BE(0x00000001, 0); // objectID
    reply.writeUInt16BE(OBJ_TYPE.USER, 4);
    Buffer.from('SUPERVISOR', 'ascii').copy(reply, 6);
    return { err: ERR.SUCCESS, reply };
  }

  // ---- Debug dump ----------------------------------------------------------
  dump() {
    const out = { objects: [] };
    for (const obj of this._objects.values()) {
      out.objects.push({
        id: obj.id, name: obj.name, type: `0x${obj.type.toString(16).padStart(4,'0')}`,
        properties: Object.fromEntries(
          Object.entries(obj.properties).map(([k, v]) => [k, {
            type: v.type,
            value: v.type === 'item'
              ? v.value.slice(0, 32).toString('utf8').replace(/\0/g, '.')
              : `[set: ${v.value.filter((_, i) => i % 4 === 0).map((_, i) => v.value.readUInt32BE(i * 4)).filter(Boolean).join(',')}]`
          }])
        ),
      });
    }
    return out;
  }
}

module.exports = { Bindery, PROP_VALUE_SIZE };
